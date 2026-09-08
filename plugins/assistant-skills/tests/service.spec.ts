import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { AssistantSkillsService } from '../src/service.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function makeAgent(ctx: Context, workspace: string, id: string): Agent {
  const sid = SessionId(id), session = Session.create(sid, [], { version: SESSION_FORMAT_VERSION, id: sid, createdAt: 1, isSeeded: false, cwd: workspace, agentPreset: 'primary' })
  const value: Agent = { id: sid, options: { provider: 'fixture', model: 'fixture' }, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }), ctx: undefined as unknown as Context,
    status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ;(value as unknown as { ctx: Context }).ctx = createScope(ctx, value).ctx
  session.append('turn/start', { turn: 1 })
  return value
}
async function fixture(twoSteps = false) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-skills-service-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context(); cleanups.push(() => ctx.fiber.restart())
  const owner = makeAgent(ctx, root, 'owner-session'), foreign = makeAgent(ctx, root, 'other-session')
  let live = true, human = true, admitted = true, deniedTool = false, revokeAfterWrite = false, budgetDenied = false, count = 0
  const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: root, preset: 'primary' }
  const principal = (agent: Agent) => live ? { principalId: agent === owner ? 'owner' : 'foreign', principalLineage: { principalRecordId: agent === owner ? 'owner-record' : 'foreign-record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } } : undefined
  ctx.provide('agents' as never, { get: (id: string) => [owner, foreign].find(agent => agent.id === id), list: () => [owner, foreign] } as never)
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: principal, currentPreferenceTurn: (agent: Agent) => human ? principal(agent) : undefined } as never)
  const charges: string[] = []
  ctx.provide('assistantPolicy' as never, { evaluateAgent: () => ({ effect: live ? 'allow' : 'deny' }), authorizeAgent: (_agent: Agent, _action: string, _resource: unknown, options: { idempotencyKey: string }) => { charges.push(options.idempotencyKey); return { effect: live && !budgetDenied ? 'allow' : 'deny' } } } as never)
  const source = { protocol: 'assistant-goals/verified-workflow-source/v1' as const, scope, goal: { id: 'source-goal', definition: { version: 1, digest: 'a'.repeat(64), objective: 'Write a source artifact' }, sessionId: String(owner.id), nativeGoalId: 'native-source' },
    runId: 'verified-run', turn: 1, acceptance: { contractId: 'contract', contractDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), verifiedAt: Date.now(), validUntil: Date.now() + 60000 },
    steps: [{ id: 'step-1', toolName: 'write', arguments: { file: 'output.txt', data: 'original' } }, ...(twoSteps ? [{ id: 'step-2', toolName: 'write', arguments: { file: 'second.txt', data: 'second' } }] : [])] }
  let verified: { goalId: string; runId: string; steps: unknown[] } | Error | undefined
  // These are Host source/admission seams, not independent acceptance fixtures.
  // Goals tests and the real Web scenario validate the provenance producer.
  ctx.provide('assistantGoals' as never, { inspectVerifiedWorkflowSource: () => source,
    inspectWorkflowRunContext: (_agent: Agent, goalId: string) => { if (!admitted) throw new Error('round not admitted'); return { scope, goalId, sessionId: String(owner.id), goalExecutionRunId: `goal-execution-${goalId}`, definition: { version: 1, digest: 'd'.repeat(64) } } },
    inspectVerifiedWorkflowRun: (_agent: Agent, goalId: string, runId: string) => { if (verified instanceof Error) throw verified; const proof = verified; return { scope, goal: { id: proof?.goalId ?? goalId, sessionId: String(owner.id), definition: { version: 1, digest: 'd'.repeat(64) } }, runId: proof?.runId ?? runId,
      acceptance: { contractId: 'trial-contract', contractDigest: 'e'.repeat(64), receiptDigest: 'f'.repeat(64), verifiedAt: Date.now(), validUntil: Date.now() + 60000 }, steps: proof?.steps ?? [] } } } as never)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(SkillRegistry)
  ctx.tools.register(defineTool({ name: 'write', description: 'Fixture filesystem writer', parameters: { file: { type: 'string', required: true }, data: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async args => { count++; await writeFile(join(root, args.file), args.data); if (revokeAfterWrite) live = false; return 'written' } }))
  const dispatches: string[] = []; const lineage: { name: string; root: string; nested: boolean }[] = []
  ctx.on('tools/execute', async (exec, next) => { dispatches.push(exec.name); lineage.push({ name: exec.name, root: exec.rootCallId, nested: exec.parent !== undefined }); return next() })
  ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'write' && deniedTool ? { kind: 'deny', reason: 'fixture current permission revoked' } : next())
  const config = { databasePath: join(root, 'skills.sqlite'), allowedTools: ['write'] }
  let plugin = await ctx.plugin(AssistantSkillsService, config)
  await expect.poll(() => ctx.tools.get('skill_save')).toBeDefined()
  const execute = (name: string, args: unknown, agent = owner) => agent.ctx.get('tools')!.execute({ callId: ToolCallId(`call-${Math.random()}`), name, arguments: args, signal: new AbortController().signal, agent })
  const save = () => execute('skill_save', { goal_id: 'source-goal', name: 'saved-write', description: 'Write the saved artifact with a typed message.', bindings_json: JSON.stringify([{ name: 'message', stepId: 'step-1', path: '/data' }]), expected_version: 0 })
  const run = (id = 'first') => execute('skill_run', { goal_id: 'new-goal', name: 'saved-write', version: 1, inputs_json: '{"message":"reused"}', invocation_id: id })
  const candidate = (parentVersion = 0) => execute('skill_candidate', { goal_id: 'source-goal', name: 'saved-write', description: 'Candidate writer.', bindings_json: JSON.stringify([{ name: 'message', stepId: 'step-1', path: '/data' }]), parent_version: parentVersion, reason: 'Owner requested a trial.', trigger: 'manual review' })
  const trial = (candidateId: string, goalId = 'trial-goal', invocationId = 'trial-invocation', inputsJson = '{"message":"candidate"}') => execute('skill_trial', { candidate_id: candidateId, goal_id: goalId, inputs_json: inputsJson, invocation_id: invocationId })
  const activate = (candidateId: string, trialRunId: string, agent = owner) => execute('skill_activate', { candidate_id: candidateId, trial_run_id: trialRunId }, agent)
  const rollback = (expectedVersion: number, targetVersion: number) => execute('skill_rollback', { name: 'saved-write', expected_version: expectedVersion, target_version: targetVersion })
  return { root, ctx, owner, foreign, save, run, execute, dispatches, lineage, charges, denyBudget: () => { budgetDenied = true }, count: () => count, human: (value: boolean) => { human = value }, admitted: (value: boolean) => { admitted = value }, deny: () => { deniedTool = true }, revokeAfterWrite: () => { revokeAfterWrite = true },
    source, candidate, trial, activate, rollback, setVerifiedTrial: (goalId: string, runId: string, args: unknown, extraSteps: unknown[] = []) => { verified = { goalId, runId, steps: [{ toolName: 'skill_trial', arguments: args }, ...extraSteps] } }, clearVerifiedTrial: () => { verified = undefined }, failVerifiedTrial: () => { verified = new Error('fixture acceptance proof expired') },
    restart: async () => { await plugin.dispose(); plugin = await ctx.plugin(AssistantSkillsService, config); await expect.poll(() => ctx.tools.get('skill_save')).toBeDefined() } }
}
function result(value: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['run']>>) {
  expect(value.isError, JSON.stringify(value)).toBe(false)
  return JSON.parse((value.value as { context: string }).context)
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
