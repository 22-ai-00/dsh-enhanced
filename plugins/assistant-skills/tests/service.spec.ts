import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createTaskAcceptanceContract, createTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import type { SkillComparisonProfile } from '../src/comparison.ts'
import { AssistantSkillsService } from '../src/service.ts'

const cleanups: (() => Promise<void>)[] = []
const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const dockerAvailable = /^sha256:[0-9a-f]{64}$/u.test(image)
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function makeAgent(ctx: Context, workspace: string, id: string): Agent {
  const sid = SessionId(id), session = Session.create(sid, [], { version: SESSION_FORMAT_VERSION, id: sid, createdAt: 1, isSeeded: false, cwd: workspace, agentPreset: 'primary' })
  const value: Agent = { id: sid, options: { provider: 'fixture', model: 'fixture' }, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }), ctx: undefined as unknown as Context,
    status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ;(value as unknown as { ctx: Context }).ctx = createScope(ctx, value).ctx
  session.append('turn/start', { turn: 1 })
  return value
}
async function fixture(twoSteps = false, comparison = false) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-skills-service-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const comparisonRoot = comparison ? await mkdtemp(join(tmpdir(), 'assistant-skills-comparison-service-')) : undefined
  if (comparisonRoot) { await chmod(comparisonRoot, 0o700); cleanups.push(() => rm(comparisonRoot, { recursive: true, force: true })) }
  const ctx = new Context(); cleanups.push(() => ctx.fiber.restart())
  const owner = makeAgent(ctx, root, 'owner-session'), foreign = makeAgent(ctx, root, 'other-session')
  let live = true, routeLive = true, routeVersion = 1, backgroundAllowed = true, human = true, admitted = true, deniedTool = false, revokeAfterWrite = false, budgetDenied = false, count = 0
  const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: root, preset: 'primary' }
  const principal = (agent: Agent) => live ? { principalId: agent === owner ? 'owner' : 'foreign', principalLineage: { principalRecordId: agent === owner ? 'owner-record' : 'foreign-record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } } : undefined
  ctx.provide('agents' as never, { get: (id: string) => [owner, foreign].find(agent => agent.id === id), list: () => [owner, foreign] } as never)
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: principal, currentPreferenceTurn: (agent: Agent) => human ? principal(agent) : undefined,
    validateOwnerRoute: (input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => routeLive && input.authorityId === 'owner-route' && input.principalId === 'owner' && input.workspace === root && input.agentPreset === 'primary' ? { authorityId: input.authorityId, principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: routeVersion, generation: 1 } : undefined } as never)
  const charges: string[] = []
  ctx.provide('assistantVerifier' as never, {} as never)
  ctx.provide('assistantPolicy' as never, { evaluate: () => ({ effect: backgroundAllowed ? 'allow' : 'deny' }), authorize: () => ({ effect: backgroundAllowed && !budgetDenied ? 'allow' : 'deny' }), evaluateAgent: () => ({ effect: live ? 'allow' : 'deny' }), authorizeAgent: (_agent: Agent, _action: string, _resource: unknown, options: { idempotencyKey: string }) => { charges.push(options.idempotencyKey); return { effect: live && !budgetDenied ? 'allow' : 'deny' } } } as never)
  const source = { protocol: 'assistant-goals/verified-workflow-source/v1' as const, scope, goal: { id: 'source-goal', definition: { version: 1, digest: 'a'.repeat(64), objective: 'Write a source artifact' }, sessionId: String(owner.id), nativeGoalId: 'native-source' },
    runId: 'verified-run', turn: 1, acceptance: { contractId: 'contract', contractDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), verifiedAt: Date.now(), validUntil: Date.now() + 60000 },
    steps: [{ id: 'step-1', toolName: 'write', arguments: comparison ? { file_path: 'result.sh', content: '#!/bin/sh\nread x\nprintf wrong' } : { file: 'output.txt', data: 'original' } }, ...(twoSteps ? [{ id: 'step-2', toolName: 'write', arguments: { file: 'second.txt', data: 'second' } }] : [])] }
  let verified: { goalId: string; runId: string; steps: unknown[] } | Error | undefined
  // These are Host source/admission seams, not independent acceptance fixtures.
  // Goals tests and the real Web scenario validate the provenance producer.
  const snapshots = new Map<string, unknown>()
  ctx.provide('assistantGoals' as never, { inspectVerifiedWorkflowSource: () => source,
    inspectWorkflowRunContext: (_agent: Agent, goalId: string) => { if (!admitted) throw new Error('round not admitted'); return { scope, goalId, sessionId: String(owner.id), goalExecutionRunId: `goal-execution-${goalId}`, nativeGoalId: `native-${goalId}`, definition: { version: 1, digest: 'd'.repeat(64) } } },
    inspectOwnerGoalExecution: (input: { goalId: string }) => snapshots.get(input.goalId) ?? { storedGoal: { definition: { digest: 'd'.repeat(64) } }, outcomeAssessments: [], acceptedTasks: [] },
    inspectVerifiedWorkflowRun: (_agent: Agent, goalId: string, runId: string) => { if (verified instanceof Error) throw verified; const proof = verified; return { scope, goal: { id: proof?.goalId ?? goalId, sessionId: String(owner.id), definition: { version: 1, digest: 'd'.repeat(64) } }, runId: proof?.runId ?? runId,
      acceptance: { contractId: 'trial-contract', contractDigest: 'e'.repeat(64), receiptDigest: 'f'.repeat(64), verifiedAt: source.acceptance.verifiedAt, validUntil: source.acceptance.validUntil }, steps: proof?.steps ?? [] } } } as never)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(SkillRegistry)
  ctx.tools.register(defineTool({ name: 'write', description: 'Fixture filesystem writer', parameters: comparison ? { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } } : { file: { type: 'string', required: true }, data: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async args => { count++; await writeFile(join(root, comparison ? args.file_path as string : args.file as string), comparison ? args.content as string : args.data as string); if (revokeAfterWrite) live = false; return 'written' } }))
  const dispatches: string[] = []; const lineage: { name: string; root: string; nested: boolean }[] = []
  ctx.on('tools/execute', async (exec, next) => { dispatches.push(exec.name); lineage.push({ name: exec.name, root: exec.rootCallId, nested: exec.parent !== undefined }); return next() })
  ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'write' && deniedTool ? { kind: 'deny', reason: 'fixture current permission revoked' } : next())
  const comparisons: SkillComparisonProfile[] | undefined = comparison ? [{ id: 'service-comparison', version: 1, scope, stateRoot: comparisonRoot!, image, dockerPath: process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker', command: '/bin/sh /workspace/artifact < /workspace/input', artifactPath: 'result.sh', expiresAt: Date.now() + 60000, maxComparisons: 1, repeats: 2, cellDurationMs: 30000, verificationDurationMs: 10000, maxToolCalls: 2, maxBytes: 65536, maxOutputBytes: 65536, minimumEvaluationGain: 0.1, cases: [
    { id: 'replay', kind: 'replay', inputs: {}, files: [], stdin: 'one\n', expectedStdout: 'one\n', expectedExitCode: 0 },
    { id: 'evaluation', kind: 'evaluation', inputs: {}, files: [], stdin: 'two\n', expectedStdout: 'two\n', expectedExitCode: 0 },
    { id: 'regression', kind: 'regression', inputs: {}, files: [], stdin: 'three\n', expectedStdout: 'three\n', expectedExitCode: 0 },
  ] }] : undefined
  const config = comparison ? { databasePath: join(root, 'skills.sqlite'), allowedTools: ['write'], comparisons: comparisons! } : { databasePath: join(root, 'skills.sqlite'), allowedTools: ['write'] }
  let plugin = await ctx.plugin(AssistantSkillsService, config)
  await expect.poll(() => ctx.tools.get('skill_save')).toBeDefined()
  const execute = (name: string, args: unknown, agent = owner) => agent.ctx.get('tools')!.execute({ callId: ToolCallId(`call-${Math.random()}`), name, arguments: args, signal: new AbortController().signal, agent })
  const save = () => execute('skill_save', { goal_id: 'source-goal', name: 'saved-write', description: 'Write the saved artifact with a typed message.', bindings_json: JSON.stringify([{ name: 'message', stepId: 'step-1', path: '/data' }]), expected_version: 0 })
  const run = (id = 'first') => execute('skill_run', { goal_id: 'new-goal', name: 'saved-write', version: 1, inputs_json: '{"message":"reused"}', invocation_id: id })
  const candidate = (parentVersion = 0) => execute('skill_candidate', { goal_id: 'source-goal', name: 'saved-write', description: 'Candidate writer.', bindings_json: JSON.stringify([{ name: 'message', stepId: 'step-1', path: '/data' }]), parent_version: parentVersion, reason: 'Owner requested a trial.', trigger: 'manual review' })
  const trial = (candidateId: string, goalId = 'trial-goal', invocationId = 'trial-invocation', inputsJson = '{"message":"candidate"}') => execute('skill_trial', { candidate_id: candidateId, goal_id: goalId, inputs_json: inputsJson, invocation_id: invocationId })
  const activate = (candidateId: string, trialRunId: string, agent = owner) => execute('skill_activate', { candidate_id: candidateId, trial_run_id: trialRunId }, agent)
  const rollback = (expectedVersion: number, targetVersion: number) => execute('skill_rollback', { name: 'saved-write', expected_version: expectedVersion, target_version: targetVersion })
  return { root, comparisonRoot, ctx, owner, foreign, save, run, execute, dispatches, lineage, charges, denyBudget: () => { budgetDenied = true }, count: () => count, human: (value: boolean) => { human = value }, admitted: (value: boolean) => { admitted = value }, deny: () => { deniedTool = true }, revokeAfterWrite: () => { revokeAfterWrite = true },
    source, candidate, trial, activate, rollback, setVerifiedTrial: (goalId: string, runId: string, args: unknown, extraSteps: unknown[] = []) => { verified = { goalId, runId, steps: [{ toolName: 'skill_trial', arguments: args }, ...extraSteps] } }, clearVerifiedTrial: () => { verified = undefined }, failVerifiedTrial: () => { verified = new Error('fixture acceptance proof expired') }, setSnapshot: (goalId: string, runId: string, status: 'achieved' | 'not-achieved', options: { expired?: boolean; wrongRun?: boolean; wrongNative?: boolean; unknownExecution?: boolean; future?: boolean; tampered?: boolean } = {}) => {
      const now = Date.now(), goal = { id: goalId, definitionVersion: 1, definitionDigest: 'd'.repeat(64), sessionId: String(owner.id), nativeGoalId: options.wrongNative ? 'foreign-native' : `native-${goalId}` }
      const contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v3', id: `outcome-${goalId}`, task: { kind: 'goal-outcome', ref: `assessment-${goalId}`, goal: { ...goal, assessmentId: `assessment-${goalId}` } },
        scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: 'owner-record', principalVersion: 1 }, objective: 'Check reused skill result', profile: { id: 'profile', version: 1, digest: 'a'.repeat(64) },
        criteria: [{ id: 'result', kind: 'target-readback', authority: { id: 'check', digest: 'a'.repeat(64) }, objectId: 'output', expected: [{ pointer: '/ready', value: true }] }], issuedAt: now - 1000, expiresAt: now + 60_000, bounds: { maxDurationMs: 1000, maxEvidenceBytes: 4096 } })
      const completedAt = options.expired ? now - 2 : options.future ? now + 1000 : now
      const receipt = createTaskVerificationReceipt(contract, { protocol: 'task-verification/v3', id: `receipt-${goalId}`, contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner, task: contract.task,
        results: [{ criterionId: 'result', status: status === 'achieved' ? 'passed' : 'failed', reason: 'independent-fixture-check', evidence: [] }], startedAt: completedAt, completedAt, validUntil: options.expired ? now - 1 : now + 60_000 })
      const execution = { status: options.unknownExecution ? 'unknown' : 'succeeded', quiescent: !options.unknownExecution, completedAt: now }
      snapshots.set(goalId, { storedGoal: { id: goalId, scope, definition: { version: 1, digest: 'd'.repeat(64) }, nativeAtLastObservation: { sessionId: String(owner.id), goalId: `native-${goalId}` } },
        executionRuns: [{ intent: { runId, scope, task: { kind: 'goal-step', goal } }, dispatchedAt: now - 1000, execution }],
        outcomeAssessments: [{ triggerRunId: options.wrongRun ? 'wrong-run' : runId, contract, dispatchedAt: now - 1000, execution }],
        acceptedTasks: [{ contractId: contract.id, state: 'done', contract, receipt: options.tampered ? { ...receipt, digest: 'f'.repeat(64) } : receipt, verifierExecutionObservation: { ...execution, executionRef: contract.task.ref } }] })
    }, denyBackground: () => { backgroundAllowed = false }, rebindRoute: () => { routeVersion++ }, revokeRoute: () => { routeLive = false },
    restart: async () => { await plugin.dispose(); plugin = await ctx.plugin(AssistantSkillsService, config); await expect.poll(() => ctx.tools.get('skill_save')).toBeDefined() } }
}
function result(value: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['run']>>) {
  expect(value.isError, JSON.stringify(value)).toBe(false)
  return JSON.parse((value.value as { context: string }).context)
}
function sealedProfile(f: Awaited<ReturnType<typeof fixture>>) {
  return { id: 'sealed-profile', version: 1, scope: { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: f.root, preset: 'primary' }, stateRoot: f.comparisonRoot!, image, dockerPath: process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker', command: '/bin/sh /workspace/artifact < /workspace/input', artifactPath: 'result.sh', expiresAt: Date.now() + 60000, maxComparisons: 1, repeats: 2, cellDurationMs: 30000, verificationDurationMs: 10000, maxToolCalls: 2, maxBytes: 65536, maxOutputBytes: 65536, minimumEvaluationGain: 0.1, cases: [
    { id: 'replay', kind: 'replay' as const, inputs: {}, files: [], stdin: 'one\n', expectedStdout: 'one\n', expectedExitCode: 0 }, { id: 'evaluation', kind: 'evaluation' as const, inputs: {}, files: [], stdin: 'two\n', expectedStdout: 'two\n', expectedExitCode: 0 }, { id: 'regression', kind: 'regression' as const, inputs: {}, files: [], stdin: 'three\n', expectedStdout: 'three\n', expectedExitCode: 0 },
  ] }
}

test('native tool composition writes parameterized artifacts, persists across restart and never repeats a duplicate invocation', async () => {
  const f = await fixture(); result(await f.save()); f.human(false)
  const first = result(await f.run())
  expect(first).toMatchObject({ state: 'succeeded', acceptance: 'requires-fresh-goal-verification', steps: [{ id: 'step-1', state: 'succeeded' }] })
  expect(await readFile(join(f.root, 'output.txt'), 'utf8')).toBe('reused')
  expect(f.dispatches).toEqual(['skill_save', 'skill_run', 'write'])
  expect(f.lineage[2]).toEqual({ name: 'write', root: f.lineage[1]!.root, nested: true })
  await f.restart(); expect((await f.owner.ctx.get('skills')!.list({ scope: f.owner })).map(value => value.name)).toEqual(['saved-write']); expect(result(await f.run()).id).toBe(first.id); expect(f.count()).toBe(1); expect(f.charges).toHaveLength(2)
  expect(result(await f.run('new-invocation')).state).toBe('succeeded'); expect(f.count()).toBe(2)
})

test('requires a human save request, exact owner and an admitted new Goal', async () => {
  const f = await fixture(); f.human(false); expect((await f.save()).isError).toBe(true)
  f.human(true); result(await f.save())
  expect(result(await f.execute('skill_status', {}, f.foreign))).toEqual([])
  f.admitted(false); expect((await f.run()).isError).toBe(true); expect(f.count()).toBe(0)
  f.admitted(true)
  expect((await f.execute('skill_run', { goal_id: 'source-goal', name: 'saved-write', version: 1, invocation_id: 'bad' })).isError).toBe(true)
})

test('rechecks current native tool guards and owner permission between saved steps', async () => {
  const f = await fixture(true); result(await f.save()); f.deny()
  const failed = await f.run(); expect(failed.isError).toBe(true); expect(failed.error?.message).toContain('is failed'); expect(f.count()).toBe(0)
  const g = await fixture(true); result(await g.save()); g.revokeAfterWrite()
  const interrupted = await g.run(); expect(interrupted.isError).toBe(true); expect(interrupted.error?.message).toContain('is unknown'); expect(g.count()).toBe(1)
})

test('exposes native skills only in the exact owner Agent scope and retirement removes discovery and replay', async () => {
  const f = await fixture(); result(await f.save())
  expect((await f.owner.ctx.get('skills')!.list({ scope: f.owner })).map(value => value.name)).toEqual(['saved-write'])
  expect(await f.foreign.ctx.get('skills')!.list({ scope: f.foreign })).toEqual([])
  expect(await f.ctx.skills.list()).toEqual([])
  expect((await f.owner.ctx.get('skills')!.get('saved-write', { scope: f.owner }))?.content).toContain('skill_run')
  result(await f.execute('skill_retire', { name: 'saved-write', expected_version: 1 }))
  expect(await f.owner.ctx.get('skills')!.list({ scope: f.owner })).toEqual([])
  expect(await f.owner.ctx.get('skills')!.get('saved-write', { scope: f.owner })).toBeUndefined()
  expect((await f.run()).isError).toBe(true); expect(f.count()).toBe(0)
})

test('a matching Policy rule is insufficient when its mutation budget authorization denies', async () => {
  const f = await fixture(); result(await f.save()); f.denyBudget()
  const denied = await f.run(); expect(denied.isError).toBe(true); expect(denied.error?.message).toContain('is failed')
  expect(f.count()).toBe(0); expect(f.charges).toHaveLength(2)
  expect((await f.run()).isError).toBe(true); expect(f.charges).toHaveLength(2)
})

test('candidate trials have native tool effects but do not alter discovery until exact accepted activation, restart, and rollback', async () => {
  const f = await fixture(); result(await f.save())
  const before = await f.owner.ctx.get('skills')!.list({ scope: f.owner })
  const candidate = result(await f.candidate(1))
  expect(candidate).toMatchObject({ state: 'pending', parentVersion: 1 }); expect((await f.owner.ctx.get('skills')!.list({ scope: f.owner })).map(value => value.name)).toEqual(before.map(value => value.name))
  const trial = result(await f.trial(candidate.id))
  expect(trial).toMatchObject({ state: 'succeeded', candidateId: candidate.id, goalExecutionRunId: 'goal-execution-trial-goal' })
  expect(await readFile(join(f.root, 'output.txt'), 'utf8')).toBe('candidate')
  expect(f.lineage.at(-1)).toMatchObject({ name: 'write', nested: true })
  expect(result(await f.execute('skill_status', { run_id: trial.id }))).toMatchObject({ candidateId: candidate.id, goalExecutionRunId: 'goal-execution-trial-goal' })
  f.setVerifiedTrial('trial-goal', 'goal-execution-trial-goal', { candidate_id: candidate.id, goal_id: 'trial-goal', inputs_json: '{"message":"candidate"}', invocation_id: 'trial-invocation' })
  expect(result(await f.activate(candidate.id, trial.id))).toMatchObject({ activeVersion: 2, activated: { version: 2 } })
  expect(result(await f.execute('skill_status', {}))).toMatchObject([{ version: 2 }])
  expect((await f.owner.ctx.get('skills')!.get('saved-write', { scope: f.owner }))?.content).toContain('version 2')
  await f.restart()
  expect(result(await f.execute('skill_status', {}))).toMatchObject([{ version: 2 }])
  expect((await f.owner.ctx.get('skills')!.get('saved-write', { scope: f.owner }))?.content).toContain('version 2')
  expect(result(await f.rollback(2, 1))).toMatchObject({ version: 3, parentVersion: 2, restoredFromVersion: 1 })
  expect((await f.owner.ctx.get('skills')!.get('saved-write', { scope: f.owner }))?.content).toContain('version 3')
})

test('activation rejects non-exact, expired, failed, unauthorized, and superseded candidate trial proof seams', async () => {
  const f = await fixture(); result(await f.save()); const candidate = result(await f.candidate(1)); const trial = result(await f.trial(candidate.id))
  const args = { candidate_id: candidate.id, goal_id: 'trial-goal', inputs_json: '{"message":"candidate"}', invocation_id: 'trial-invocation' }
  f.setVerifiedTrial('trial-goal', 'wrong-run', args)
  expect((await f.activate(candidate.id, trial.id)).isError).toBe(true)
  f.setVerifiedTrial('trial-goal', 'goal-execution-trial-goal', args, [{ toolName: 'repair', arguments: {} }])
  expect((await f.activate(candidate.id, trial.id)).isError).toBe(true)
  f.failVerifiedTrial(); expect((await f.activate(candidate.id, trial.id)).isError).toBe(true)
  f.setVerifiedTrial('trial-goal', 'goal-execution-trial-goal', args); f.human(false)
  expect((await f.activate(candidate.id, trial.id)).isError).toBe(true); f.human(true)

  const g = await fixture(); result(await g.save()); const changed = result(await g.candidate(1)); const changedTrial = result(await g.trial(changed.id))
  g.setVerifiedTrial('trial-goal', 'goal-execution-trial-goal', { candidate_id: changed.id, goal_id: 'trial-goal', inputs_json: '{"message":"candidate"}', invocation_id: 'trial-invocation' })
  g.source.steps[0]!.arguments = { file: 'output.txt', data: 'new active version' }
  result(await g.execute('skill_save', { goal_id: 'source-goal', name: 'saved-write', description: 'Write v2.', bindings_json: JSON.stringify([{ name: 'message', stepId: 'step-1', path: '/data' }]), expected_version: 1 }))
  expect((await g.activate(changed.id, changedTrial.id)).isError).toBe(true)

  const h = await fixture(); const failedCandidate = result(await h.candidate()); h.deny()
  const failed = await h.trial(failedCandidate.id); expect(failed.isError).toBe(true)
  const failedRun = /invocation (skill-run-[a-f0-9]+) is failed/u.exec(failed.error?.message ?? '')?.[1]
  expect(failedRun).toBeDefined(); expect((await h.activate(failedCandidate.id, failedRun!)).isError).toBe(true)
})

const dockerTest = dockerAvailable ? test : test.skip
dockerTest('compares a pending native-file candidate through isolated verification without changing the active skill', async () => {
  // Source and fresh-Goal admission below are Host seams. This test exercises the real
  // ToolRuntime -> SkillComparator -> native replay -> Docker verifier path.
  const f = await fixture(false, true)
  const saved = result(await f.execute('skill_save', { goal_id: 'source-goal', name: 'saved-write', description: 'Write the result script.', bindings_json: '[]', expected_version: 0 }))
  expect(saved).toMatchObject({ name: 'saved-write', version: 1 })
  f.source.steps[0]!.arguments = { file_path: 'result.sh', content: '#!/bin/sh\ncat' }
  const candidate = result(await f.execute('skill_candidate', { goal_id: 'source-goal', name: 'saved-write', description: 'Write the result script with cat.', bindings_json: '[]', parent_version: 1, reason: 'Measured candidate.', trigger: 'owner review' }))
  expect(candidate).toMatchObject({ state: 'pending', parentVersion: 1 })

  const compared = result(await f.execute('skill_compare', { candidate_id: candidate.id, profile_id: 'service-comparison', invocation_id: 'compare-once' }))
  expect(compared).toMatchObject({ state: 'complete', candidateId: candidate.id, profileId: 'service-comparison' })
  const report = compared.result as { execution: string; modelCalls: number; cells: { toolCalls: number; quiescent: boolean }[]; quality: { evaluationGain: number; evaluationGainObserved: boolean; candidateChecksPassed: boolean; criticalRegressionsPassed: boolean }; promotionAuthorized: boolean }
  expect(report).toMatchObject({ execution: 'native-file-tools-and-isolated-artifact', modelCalls: 0, quality: { evaluationGain: 1, evaluationGainObserved: true, candidateChecksPassed: true, criticalRegressionsPassed: true }, promotionAuthorized: false })
  expect(report.cells).toHaveLength(12)
  expect(report.cells.every(cell => cell.toolCalls === 1 && cell.quiescent)).toBe(true)
  expect(result(await f.execute('skill_status', {}))).toMatchObject([{ name: 'saved-write', version: 1 }])
  expect(result(await f.execute('skill_candidates', { candidate_id: candidate.id }))).toMatchObject({ state: 'pending', id: candidate.id })

  const duplicate = result(await f.execute('skill_compare', { candidate_id: candidate.id, profile_id: 'service-comparison', invocation_id: 'compare-once' }))
  expect(duplicate).toEqual(compared)
  await f.restart()
  expect(result(await f.execute('skill_comparison_status', { comparison_id: compared.id }))).toEqual(compared)
  expect(result(await f.execute('skill_comparison_status', {}, f.foreign))).toEqual([])
  expect(result(await f.execute('skill_comparison_status', { comparison_id: compared.id }, f.foreign))).toBeNull()
  const exhausted = await f.execute('skill_compare', { candidate_id: candidate.id, profile_id: 'service-comparison', invocation_id: 'comparison-budget-exhausted' })
  expect(exhausted.isError).toBe(true)
}, 120000)

dockerTest('consumes a Host-attested plan through native replay while independence remains unproven', async () => {
  const f = await fixture(false, true)
  result(await f.execute('skill_save', { goal_id: 'source-goal', name: 'saved-write', description: 'Write result.', bindings_json: '[]', expected_version: 0 }))
  f.source.steps[0]!.arguments = { file_path: 'result.sh', content: '#!/bin/sh\ncat' }
  const candidate = result(await f.execute('skill_candidate', { goal_id: 'source-goal', name: 'saved-write', description: 'Candidate result.', bindings_json: '[]', parent_version: 1, reason: 'sealed host qualification', trigger: 'owner review' }))
  const service = f.ctx.assistantSkills
  const configured = [{ id: 'sealed-profile', version: 1, scope: { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: f.root, preset: 'primary' }, stateRoot: f.comparisonRoot!, image, dockerPath: process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker', command: '/bin/sh /workspace/artifact < /workspace/input', artifactPath: 'result.sh', expiresAt: Date.now() + 60000, maxComparisons: 1, repeats: 2, cellDurationMs: 30000, verificationDurationMs: 10000, maxToolCalls: 2, maxBytes: 65536, maxOutputBytes: 65536, minimumEvaluationGain: 0.1, cases: [
    { id: 'replay', kind: 'replay', inputs: {}, files: [], stdin: 'one\n', expectedStdout: 'one\n', expectedExitCode: 0 }, { id: 'evaluation', kind: 'evaluation', inputs: {}, files: [], stdin: 'two\n', expectedStdout: 'two\n', expectedExitCode: 0 }, { id: 'regression', kind: 'regression', inputs: {}, files: [], stdin: 'three\n', expectedStdout: 'three\n', expectedExitCode: 0 },
  ] }] as const
  service.registerSealedHoldoutProvider({ generation: 'host', read: ({ planId }) => planId === 'sealed' ? { profile: configured[0] as never, attestationDigest: '8'.repeat(64) } : undefined })
  const binding = service.inspectSealedHoldout('sealed', { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: f.root, preset: 'primary' })
  const receipt = await service.qualifySealedHoldout({ agent: f.owner, signal: new AbortController().signal } as never, candidate.id, 'sealed', 'sealed-once')
  expect(receipt).toMatchObject({ state: 'complete', result: { hostAttestedHoldout: { bindingDigest: binding.bindingDigest }, promotionAuthorized: false, quality: { heldoutIndependence: 'unproven' } } })
  expect((receipt.result as { quality: Record<string, unknown> }).quality.hostAttestedHoldout).toBeUndefined()
  expect(JSON.stringify(receipt)).not.toContain('expectedStdout')
  expect(result(await f.execute('skill_status', {}))).toMatchObject([{ version: 1 }])
  expect(await service.qualifySealedHoldout({ agent: f.owner, signal: new AbortController().signal } as never, candidate.id, 'sealed', 'sealed-once')).toEqual(receipt)
}, 120000)

dockerTest('sealed qualification rejects provider revocation or profile drift before replay and preserves the active version', async () => {
  for (const mode of ['revoked', 'drifted'] as const) {
    const f = await fixture(false, true)
    result(await f.execute('skill_save', { goal_id: 'source-goal', name: 'saved-write', description: 'Write result.', bindings_json: '[]', expected_version: 0 }))
    f.source.steps[0]!.arguments = { file_path: 'result.sh', content: '#!/bin/sh\ncat' }
    const candidate = result(await f.execute('skill_candidate', { goal_id: 'source-goal', name: 'saved-write', description: 'Candidate result.', bindings_json: '[]', parent_version: 1, reason: 'sealed host qualification', trigger: 'owner review' }))
    const service = f.ctx.assistantSkills, profile = sealedProfile(f); let reads = 0
    service.registerSealedHoldoutProvider({ generation: 'host', read: () => { reads++; if (mode === 'revoked' && reads > 1) return undefined; if (mode === 'drifted' && reads > 1) return { profile: { ...profile, minimumEvaluationGain: 0.2 }, attestationDigest: '8'.repeat(64) }; return { profile, attestationDigest: '8'.repeat(64) } } })
    await expect(service.qualifySealedHoldout({ agent: f.owner, signal: new AbortController().signal } as never, candidate.id, 'sealed', `sealed-${mode}`)).rejects.toThrow(/unknown/)
    expect(result(await f.execute('skill_status', {}))).toMatchObject([{ version: 1 }])
    expect(f.count()).toBe(0)
  }
}, 120000)

dockerTest('sealed qualification turns unknown when the candidate parent changes during the comparison', async () => {
  const f = await fixture(false, true)
  result(await f.execute('skill_save', { goal_id: 'source-goal', name: 'saved-write', description: 'Write result.', bindings_json: '[]', expected_version: 0 }))
  f.source.steps[0]!.arguments = { file_path: 'result.sh', content: '#!/bin/sh\ncat' }
  const candidate = result(await f.execute('skill_candidate', { goal_id: 'source-goal', name: 'saved-write', description: 'Candidate result.', bindings_json: '[]', parent_version: 1, reason: 'sealed host qualification', trigger: 'owner review' }))
  const service = f.ctx.assistantSkills, profile = sealedProfile(f); let reads = 0
  service.registerSealedHoldoutProvider({ generation: 'host', read: () => { if (++reads === 2) setTimeout(() => { void f.execute('skill_retire', { name: 'saved-write', expected_version: 1 }) }, 0); return { profile, attestationDigest: '8'.repeat(64) } } })
  await expect(service.qualifySealedHoldout({ agent: f.owner, signal: new AbortController().signal } as never, candidate.id, 'sealed', 'sealed-parent-drift')).rejects.toThrow(/unknown/)
  expect(result(await f.execute('skill_status', {}))).toEqual([])
}, 120000)

async function watchedFixture(failureThreshold = 1, maxRuns = 2) {
  const f = await fixture(); result(await f.save())
  result(await f.execute('skill_save', { goal_id: 'source-goal', name: 'saved-write', description: 'Second version', bindings_json: JSON.stringify([{ name: 'message', stepId: 'step-1', path: '/data' }]), expected_version: 1 }))
  const expiresAt = Date.now() + 60_000
  const watch = result(await f.execute('skill_watch', { owner_route_id: 'owner-route', name: 'saved-write', version: 2, fallback_version: 1, expires_at: expiresAt, max_runs: maxRuns, failure_threshold: failureThreshold }))
  const use = async (goalId: string) => result(await f.execute('skill_run', { goal_id: goalId, name: 'saved-write', version: 2, inputs_json: '{"message":"observed"}', invocation_id: goalId }))
  const watches = async () => result(await f.execute('skill_watches', {}))
  const nudge = async () => { f.ctx.emit('assistant-verifier/receipt', { taskKind: 'goal-outcome' } as never); await new Promise<void>(resolve => setImmediate(resolve)) }
  return { ...f, watch, expiresAt, use, watches, nudge }
}

test('finite watch rolls back exactly once after a later independent failure, including restart and duplicate nudges', async () => {
  const f = await watchedFixture(); f.human(false)
  const run = await f.use('watched-goal')
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'not-achieved')
  await f.restart()
  await expect.poll(async () => (await f.watches())[0].state).toBe('rolled-back')
  expect(result(await f.execute('skill_status', {}))).toMatchObject([{ version: 3, restoredFromVersion: 1 }])
  await f.nudge(); await f.restart(); await f.nudge()
  expect(result(await f.execute('skill_status', {}))[0].version).toBe(3)
  expect((await f.watches())[0].observations).toHaveLength(1)
  expect(f.count()).toBe(1)
})

test.each(['wrongRun', 'wrongNative', 'unknownExecution', 'expired', 'future', 'tampered'] as const)('watch rejects %s evidence without changing the skill', async invalid => {
  const f = await watchedFixture(); const run = await f.use(`invalid-${invalid}`)
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'not-achieved', { [invalid]: true }); await f.nudge()
  expect((await f.watches())[0]).toMatchObject({ state: 'watching', observations: [] })
  expect(result(await f.execute('skill_status', {}))[0].version).toBe(2)
})

test.each(['route', 'rebind', 'policy', 'expiry'] as const)('watch stops after %s authority ends', async change => {
  const f = await watchedFixture(); const run = await f.use(`revoke-${change}`)
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'not-achieved')
  if (change === 'route') f.revokeRoute()
  if (change === 'rebind') f.rebindRoute()
  if (change === 'policy') f.denyBackground()
  if (change === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(f.expiresAt)
  await f.nudge()
  expect((await f.watches())[0].state).toBe(change === 'expiry' ? 'expired' : 'revoked')
  expect(result(await f.execute('skill_status', {}))[0].version).toBe(2)
})

test('positive observations exhaust a finite watch without rollback and one failed run cannot count twice', async () => {
  const f = await watchedFixture(2, 2), first = await f.use('first-observed')
  f.setSnapshot(first.goalId, first.goalExecutionRunId, 'not-achieved'); await f.nudge(); await f.nudge()
  expect((await f.watches())[0]).toMatchObject({ state: 'watching', observations: [expect.objectContaining({ runId: first.id })] })
  const second = await f.use('second-observed')
  f.setSnapshot(second.goalId, second.goalExecutionRunId, 'achieved'); await f.nudge()
  expect((await f.watches())[0]).toMatchObject({ state: 'exhausted', observations: [expect.anything(), expect.anything()] })
  expect(result(await f.execute('skill_status', {}))[0].version).toBe(2)
})
