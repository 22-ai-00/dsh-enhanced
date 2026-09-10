import { Context, Service } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { acceptanceDigest, createTaskAcceptanceContract, createTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import { SkillComparator, type SkillComparisonProfile } from '../src/comparison.ts'
import { failureSummaryEvidenceDigest, type HostFailureEvidenceSummary, type VerifiedWorkflowSource } from '../src/definition.ts'
import * as HoldoutQualification from '../src/holdout-qualification.ts'
import { AssistantSkillsService } from '../src/service.ts'

const cleanups: (() => Promise<void>)[] = []
const image = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
const dockerAvailable = /^sha256:[0-9a-f]{64}$/u.test(image)
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function runRows(root: string): number { const database = new DatabaseSync(join(root, 'skills.sqlite')); try { return (database.prepare('SELECT count(*) AS count FROM skill_runs').get() as { count: number }).count } finally { database.close() } }
function makeAgent(ctx: Context, workspace: string, id: string, sessionId = id): Agent {
  const sid = SessionId(sessionId), session = Session.create(sid, [], { version: SESSION_FORMAT_VERSION, id: sid, createdAt: 1, isSeeded: false, cwd: workspace, agentPreset: 'primary' })
  const value: Agent = { id: SessionId(id), options: { provider: 'fixture', model: 'fixture' }, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }), ctx: undefined as unknown as Context,
    status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ;(value as unknown as { ctx: Context }).ctx = createScope(ctx, value).ctx
  session.append('turn/start', { turn: 1 })
  return value
}
async function fixture(twoSteps = false, comparison = false, ownerAgentId = 'owner-session', ownerSessionId = ownerAgentId, externalHoldouts?: (input: { root: string; scope: object }) => any[], comparisonImage = image) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-skills-service-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const comparisonRoot = comparison ? await mkdtemp(join(tmpdir(), 'assistant-skills-comparison-service-')) : undefined
  if (comparisonRoot) { await chmod(comparisonRoot, 0o700); cleanups.push(() => rm(comparisonRoot, { recursive: true, force: true })) }
  const ctx = new Context(); cleanups.push(() => ctx.fiber.restart())
  const owner = makeAgent(ctx, root, ownerAgentId, ownerSessionId), foreign = makeAgent(ctx, root, 'other-session')
  const ownerSession = String(owner.session.id)
  let live = true, routeLive = true, routeVersion = 1, backgroundAllowed = true, human = true, admitted = true, deniedTool = false, revokeAfterWrite = false, budgetDenied = false, count = 0
  const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: root, preset: 'primary' }
  const principal = (agent: Agent) => live ? { principalId: agent === owner ? 'owner' : 'foreign', principalLineage: { principalRecordId: agent === owner ? 'owner-record' : 'foreign-record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } } : undefined
  ctx.provide('agents' as never, { get: (id: string) => [owner, foreign].find(agent => agent.id === id), list: () => [owner, foreign] } as never)
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: principal, currentPreferenceTurn: (agent: Agent) => human ? principal(agent) : undefined,
    validateOwnerRoute: (input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => routeLive && input.authorityId === 'owner-route' && input.principalId === 'owner' && input.workspace === root && input.agentPreset === 'primary' ? { authorityId: input.authorityId, principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: routeVersion, generation: 1 } : undefined } as never)
  const charges: string[] = []
  ctx.provide('assistantVerifier' as never, {} as never)
  ctx.provide('assistantPolicy' as never, { evaluate: () => ({ effect: backgroundAllowed ? 'allow' : 'deny' }), authorize: () => ({ effect: backgroundAllowed && !budgetDenied ? 'allow' : 'deny' }), evaluateAgent: () => ({ effect: live ? 'allow' : 'deny' }), authorizeAgent: (_agent: Agent, _action: string, _resource: unknown, options: { idempotencyKey: string }) => { charges.push(options.idempotencyKey); return { effect: live && !budgetDenied ? 'allow' : 'deny' } } } as never)
  const source = { protocol: 'assistant-goals/verified-workflow-source/v1' as const, scope, goal: { id: 'source-goal', definition: { version: 1, digest: 'a'.repeat(64), objective: 'Write a source artifact' }, sessionId: ownerSession, nativeGoalId: 'native-source-goal' },
    runId: 'verified-run', turn: 1, acceptance: { contractId: 'contract', contractDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), verifiedAt: Date.now(), validUntil: Date.now() + 60000 },
    steps: [{ id: 'step-1', toolName: 'write', arguments: comparison ? { file_path: 'result.sh', content: '#!/bin/sh\nread x\nprintf wrong' } : { file: 'output.txt', data: 'original' } }, ...(twoSteps ? [{ id: 'step-2', toolName: 'write', arguments: { file: 'second.txt', data: 'second' } }] : [])], failedObservations: [] as { id: string; toolName: string; arguments: unknown; outcome: 'failed' }[] }
  let verified: { goalId: string; runId: string; steps: unknown[] } | Error | undefined
  // These are Host source/admission seams, not independent acceptance fixtures.
  // Goals tests and the real Web scenario validate the provenance producer.
  const snapshots = new Map<string, unknown>()
  let automaticSource: typeof source | Error | undefined, automaticDefinitionDigest = 'd'.repeat(64)
  let bridgeRequiresSessionQuery = false, sessionQueryReady = false
  let automaticGate: Promise<void> | undefined, releaseAutomaticGate: (() => void) | undefined
  ctx.provide('assistantGoals' as never, { inspectVerifiedWorkflowSource: () => source,
    inspectOwnerVerifiedWorkflowSource: async () => { await automaticGate; if (bridgeRequiresSessionQuery && !sessionQueryReady) throw Object.assign(new Error('session query unavailable'), { code: 'unavailable' }); if (automaticSource instanceof Error) throw automaticSource; if (!automaticSource) throw Object.assign(new Error('not completed'), { code: 'pending' }); return automaticSource },
    inspectActiveWorkflowCaptureContext: (agent: Agent, goalId: string) => { if (!human || agent !== owner) throw new Error('active owner Goal unavailable'); return { scope, goalId, sessionId: ownerSession, nativeGoalId: `native-${goalId}`, definition: { digest: 'd'.repeat(64) } } },
    inspectWorkflowRunContext: (_agent: Agent, goalId: string) => { if (!admitted) throw new Error('round not admitted'); return { scope, goalId, sessionId: ownerSession, goalExecutionRunId: `goal-execution-${goalId}`, nativeGoalId: `native-${goalId}`, definition: { version: 1, digest: 'd'.repeat(64) } } },
    inspectOwnerGoalExecution: (input: { goalId: string }) => snapshots.get(input.goalId) ?? { storedGoal: { definition: { digest: 'd'.repeat(64) }, nativeAtLastObservation: { sessionId: ownerSession, goalId: `native-${input.goalId}`, phase: 'active' } }, outcomeAssessments: [], acceptedTasks: [] },
    inspectOwnerGoalRunProof: async (input: { goalId: string; runId: string }) => {
      const snapshot = snapshots.get(input.goalId) as { storedGoal?: { definition?: { digest?: string } }; executionRuns?: { intent?: { task?: { goal?: { nativeRevision?: number } } } }[]; outcomeAssessments?: { contract?: { profile?: { id?: string; version?: number; digest?: string } } }[] } | undefined
      const profile = snapshot?.outcomeAssessments?.[0]?.contract?.profile, nativeRevision = snapshot?.executionRuns?.[0]?.intent?.task?.goal?.nativeRevision ?? 1
      const inputs = '{"message":"observed"}', steps = [{ id: `call-${input.runId}`, name: 'skill_run', arguments: { goal_id: input.goalId, name: 'saved-write', version: 2, inputs_json: inputs, invocation_id: input.goalId }, outcome: 'succeeded' as const }]
      const proof = { protocol: 'assistant-goals/owner-run-trace/v1' as const, runId: input.runId, turn: 1, nativeRevision, definitionDigest: snapshot?.storedGoal?.definition?.digest ?? 'd'.repeat(64), outcomeProfile: { id: profile?.id ?? 'profile', version: profile?.version ?? 1, digest: profile?.digest ?? 'a'.repeat(64) }, steps }
      return { ...proof, traceDigest: acceptanceDigest(proof) }
    },
    inspectVerifiedWorkflowRun: (_agent: Agent, goalId: string, runId: string) => { if (verified instanceof Error) throw verified; const proof = verified; return { scope, goal: { id: proof?.goalId ?? goalId, sessionId: ownerSession, definition: { version: 1, digest: 'd'.repeat(64) } }, runId: proof?.runId ?? runId,
      acceptance: { contractId: 'trial-contract', contractDigest: 'e'.repeat(64), receiptDigest: 'f'.repeat(64), verifiedAt: source.acceptance.verifiedAt, validUntil: source.acceptance.validUntil }, steps: proof?.steps ?? [] } } } as never)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(SkillRegistry)
  ctx.tools.register(defineTool({ name: 'write', description: 'Fixture filesystem writer', parameters: comparison ? { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } } : { file: { type: 'string', required: true }, data: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async args => { count++; await writeFile(join(root, comparison ? args.file_path as string : args.file as string), comparison ? args.content as string : args.data as string); if (revokeAfterWrite) live = false; return 'written' } }))
  const dispatches: string[] = []; const lineage: { name: string; root: string; nested: boolean }[] = []
  ctx.on('tools/execute', async (exec, next) => { dispatches.push(exec.name); lineage.push({ name: exec.name, root: exec.rootCallId, nested: exec.parent !== undefined }); return next() })
  ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'write' && deniedTool ? { kind: 'deny', reason: 'fixture current permission revoked' } : next())
  const comparisons: SkillComparisonProfile[] | undefined = comparison ? [{ id: 'service-comparison', version: 1, scope, stateRoot: comparisonRoot!, image: comparisonImage, dockerPath: process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker', command: '/bin/sh /workspace/artifact < /workspace/input', artifactPath: 'result.sh', expiresAt: Date.now() + 60000, maxComparisons: 1, repeats: 2, cellDurationMs: 30000, verificationDurationMs: 10000, maxToolCalls: 2, maxBytes: 65536, maxOutputBytes: 65536, minimumEvaluationGain: 0.1, cases: [
    { id: 'replay', kind: 'replay', inputs: {}, files: [], stdin: 'one\n', expectedStdout: 'one\n', expectedExitCode: 0 },
    { id: 'evaluation', kind: 'evaluation', inputs: {}, files: [], stdin: 'two\n', expectedStdout: 'two\n', expectedExitCode: 0 },
    { id: 'regression', kind: 'regression', inputs: {}, files: [], stdin: 'three\n', expectedStdout: 'three\n', expectedExitCode: 0 },
  ] }] : undefined
  const config = { databasePath: join(root, 'skills.sqlite'), allowedTools: ['write'], ...(comparison ? { comparisons: comparisons! } : {}), ...(externalHoldouts ? { externalHoldouts: externalHoldouts({ root, scope }) } : {}) }
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
    source, candidate, trial, activate, rollback, enableAutomaticSource: () => { automaticSource = { ...source, goal: { ...source.goal, definition: { ...source.goal.definition, digest: automaticDefinitionDigest } } } }, addFailedReadObservation: () => { source.failedObservations.push({ id: 'missing-read', toolName: 'read', arguments: { file: 'missing.txt' }, outcome: 'failed' }) }, requireSessionQuery: () => { bridgeRequiresSessionQuery = true }, provideSessionQuery: () => { sessionQueryReady = true; ctx.provide('sessionQuery' as never, {} as never) }, changeAutomaticDefinition: () => { automaticDefinitionDigest = 'e'.repeat(64) }, holdAutomaticSource: () => { automaticGate = new Promise(resolve => { releaseAutomaticGate = resolve }) }, releaseAutomaticSource: () => { releaseAutomaticGate?.(); automaticGate = undefined; releaseAutomaticGate = undefined }, setAutomaticSourceError: () => { automaticSource = Object.assign(new Error('unknown outcome'), { code: 'unknown' }) }, setVerifiedTrial: (goalId: string, runId: string, args: unknown, extraSteps: unknown[] = []) => { verified = { goalId, runId, steps: [{ toolName: 'skill_trial', arguments: args }, ...extraSteps] } }, setVerifiedTrialSteps: (goalId: string, runId: string, steps: unknown[]) => { verified = { goalId, runId, steps } }, clearVerifiedTrial: () => { verified = undefined }, failVerifiedTrial: () => { verified = new Error('fixture acceptance proof expired') }, setSnapshot: (goalId: string, runId: string, status: 'achieved' | 'not-achieved', options: { expired?: boolean; wrongRun?: boolean; wrongNative?: boolean; unknownExecution?: boolean; future?: boolean; tampered?: boolean } = {}) => {
      const now = Date.now(), goal = { id: goalId, definitionVersion: 1, definitionDigest: 'd'.repeat(64), sessionId: ownerSession, nativeGoalId: options.wrongNative ? 'foreign-native' : `native-${goalId}` }
      const contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v3', id: `outcome-${goalId}`, task: { kind: 'goal-outcome', ref: `assessment-${goalId}`, goal: { ...goal, assessmentId: `assessment-${goalId}` } },
        scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: 'owner-record', principalVersion: 1 }, objective: 'Check reused skill result', profile: { id: 'profile', version: 1, digest: 'a'.repeat(64) },
        criteria: [{ id: 'result', kind: 'target-readback', authority: { id: 'check', digest: 'a'.repeat(64) }, objectId: 'output', expected: [{ pointer: '/ready', value: true }] }], issuedAt: now - 1000, expiresAt: now + 60_000, bounds: { maxDurationMs: 1000, maxEvidenceBytes: 4096 } })
      const completedAt = options.expired ? now - 2 : options.future ? now + 1000 : now
      const receipt = createTaskVerificationReceipt(contract, { protocol: 'task-verification/v3', id: `receipt-${goalId}`, contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner, task: contract.task,
        results: [{ criterionId: 'result', status: status === 'achieved' ? 'passed' : 'failed', reason: 'independent-fixture-check', evidence: [] }], startedAt: completedAt, completedAt, validUntil: options.expired ? now - 1 : now + 60_000 })
      const execution = { status: options.unknownExecution ? 'unknown' : 'succeeded', quiescent: !options.unknownExecution, completedAt: now }
      snapshots.set(goalId, { storedGoal: { id: goalId, scope, definition: { version: 1, digest: 'd'.repeat(64) }, nativeAtLastObservation: { sessionId: ownerSession, goalId: `native-${goalId}` } },
        executionRuns: [{ intent: { runId, scope, task: { kind: 'goal-step', goal: { ...goal, nativeRevision: 1 } } }, dispatchedAt: now - 1000, execution }],
        outcomeAssessments: [{ triggerRunId: options.wrongRun ? 'wrong-run' : runId, contract, dispatchedAt: now - 1000, execution }],
        acceptedTasks: [{ contractId: contract.id, state: 'done', contract, receipt: options.tampered ? { ...receipt, digest: 'f'.repeat(64) } : receipt, verifierExecutionObservation: { ...execution, executionRef: contract.task.ref } }] })
    }, denyBackground: () => { backgroundAllowed = false }, rebindRoute: () => { routeVersion++ }, revokeRoute: () => { routeLive = false },
    restart: async () => { await plugin.dispose(); plugin = await ctx.plugin(AssistantSkillsService, config); await expect.poll(() => ctx.tools.get('skill_save')).toBeDefined() } }
}
function result(value: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['run']>>) {
  expect(value.isError, JSON.stringify(value)).toBe(false)
  return JSON.parse((value.value as { context: string }).context)
}
function failureEvidence(f: Awaited<ReturnType<typeof fixture>>) {
  const objective = 'Write a source artifact', definition = { version: 1, digest: acceptanceDigest({ objective }), objective }, now = Date.now()
  const repair: VerifiedWorkflowSource = { ...f.source, goal: { id: 'repair-goal', definition, sessionId: 'repair-session', nativeGoalId: 'repair-native' }, runId: 'repair-run',
    acceptance: { ...f.source.acceptance, verifiedAt: now - 1_000, validUntil: now + 60_000 } }
  const unsigned = { protocol: 'assistant-skills/host-failure-evidence/v1' as const, scope: repair.scope, taskFamily: { id: 'write-artifact', definitionDigest: definition.digest, objective },
    failureCategory: 'objective-not-achieved' as const, triggerCondition: { kind: 'not-achieved-count' as const, minimumOccurrences: 1, windowStartedAt: now - 2_000, windowEndedAt: now - 2_000 },
    failures: [{ goal: { id: 'trigger-goal', definition, sessionId: 'trigger-session', nativeGoalId: 'trigger-native' }, runId: 'trigger-run', execution: { status: 'succeeded' as const, quiescent: true as const }, outcome: 'not-achieved' as const,
      acceptance: { contractId: 'failure-contract', contractDigest: '1'.repeat(64), receiptDigest: '2'.repeat(64), verifiedAt: now - 2_000, validUntil: now + 60_000 }, traceDigest: '3'.repeat(64) }], repairGoal: repair.goal, attestedAt: now }
  const generation = 'goals-generation-1'
  const summary: HostFailureEvidenceSummary = { ...unsigned, evidence: { producer: 'assistant-goals', generation, digest: failureSummaryEvidenceDigest(unsigned, generation) } }
  return { repair, summary, generation }
}
function installFailureHost(f: Awaited<ReturnType<typeof fixture>>, mutate?: (read: { kind: 'failure' | 'repair'; count: number }, state: { repair: VerifiedWorkflowSource; summary: HostFailureEvidenceSummary; generation: string }) => void) {
  const state = failureEvidence(f), goals = f.ctx.get('assistantGoals')! as any
  let failureReads = 0, repairReads = 0
  goals.trustedAcceptanceProducerGeneration = () => state.generation
  goals.inspectOwnerFailureCaptureSummary = async () => { failureReads++; mutate?.({ kind: 'failure', count: failureReads }, state); return structuredClone(state.summary) }
  goals.inspectOwnerVerifiedWorkflowSource = async () => { repairReads++; mutate?.({ kind: 'repair', count: repairReads }, state); return structuredClone(state.repair) }
  return Object.assign(state, { failureReadCount: () => failureReads, repairReadCount: () => repairReads })
}
function failureCandidateArgs(extra: Record<string, unknown> = {}) { return { owner_route_id: 'owner-route', trigger_goal_id: 'trigger-goal', trigger_session_id: 'trigger-session', repair_goal_id: 'repair-goal', repair_session_id: 'repair-session', task_family_id: 'write-artifact', name: 'saved-write', description: 'Repair writer.', bindings_json: JSON.stringify([{ name: 'message', stepId: 'step-1', path: '/data' }]), parent_version: 1, ...extra } }
function sealedProfile(f: Awaited<ReturnType<typeof fixture>>) {
  return { id: 'sealed-profile', version: 1, scope: { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: f.root, preset: 'primary' }, stateRoot: f.comparisonRoot!, image, dockerPath: process.env.DSH_ISOLATION_TEST_DOCKER ?? '/usr/bin/docker', command: '/bin/sh /workspace/artifact < /workspace/input', artifactPath: 'result.sh', expiresAt: Date.now() + 60000, maxComparisons: 1, repeats: 2, cellDurationMs: 30000, verificationDurationMs: 10000, maxToolCalls: 2, maxBytes: 65536, maxOutputBytes: 65536, minimumEvaluationGain: 0.1, cases: [
    { id: 'replay', kind: 'replay' as const, inputs: {}, files: [], stdin: 'one\n', expectedStdout: 'one\n', expectedExitCode: 0 }, { id: 'evaluation', kind: 'evaluation' as const, inputs: {}, files: [], stdin: 'two\n', expectedStdout: 'two\n', expectedExitCode: 0 }, { id: 'regression', kind: 'regression' as const, inputs: {}, files: [], stdin: 'three\n', expectedStdout: 'three\n', expectedExitCode: 0 },
  ] }
}
function canaryProfile({ root, scope }: { root: string; scope: object }) {
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return [{ id: 'canary', version: 1, scope, execution: { image: `sha256:${'a'.repeat(64)}`, dockerPath: process.execPath,
    stateRoot: join(tmpdir(), `assistant-skills-canary-${root.split('/').pop()}`), command: '/bin/sh /workspace/artifact', artifactPath: 'result.sh', expiresAt: Date.now() + 60000,
    repeats: 2, maxToolCalls: 2, maxBytes: 4096, maxOutputBytes: 1024, cellDurationMs: 1000, verificationDurationMs: 1 },
  authority: { executable: process.execPath, args: [], publicKey, generatorDigest: '1'.repeat(64) }, maxComparisons: 1 }]
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

test('skill_canary is registered, requires a current owner and rejects an unavailable prospective profile before creating deployment state', async () => {
  const f = await fixture(); result(await f.save())
  const candidate = result(await f.candidate(1))
  const args = { candidate_id: candidate.id, profile_id: 'missing', invocation_id: 'canary-once', owner_route_id: 'owner-route', expires_at: Date.now() + 60000, max_runs: 2, canary_runs: 1 }
  expect(result(await f.execute('skill_deployment_status', {}))).toEqual([])
  expect((await f.execute('skill_canary', args)).isError).toBe(true)
  expect(result(await f.execute('skill_deployment_status', {}))).toEqual([])
  f.human(false)
  expect((await f.execute('skill_canary', args)).isError).toBe(true)
})

test('skill_failure_candidate exposes only identity and definition inputs and persists Host-produced provenance across restart', async () => {
  const f = await fixture(); result(await f.save()); installFailureHost(f)
  const parameters = f.ctx.tools.get('skill_failure_candidate')!.parameters as Record<string, unknown>
  expect(parameters).not.toHaveProperty('summary'); expect(parameters).not.toHaveProperty('provenance'); expect(parameters).not.toHaveProperty('digest'); expect(parameters).not.toHaveProperty('outcome')
  const candidate = result(await f.execute('skill_failure_candidate', failureCandidateArgs()))
  expect(candidate).toMatchObject({ state: 'pending', parentVersion: 1, reason: 'Host-verified, evidence-bound repair after an independently verified failure.',
    trigger: 'host-verified-failure:objective-not-achieved',
    definition: { name: 'saved-write', source: { goalDefinitionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), stepCount: 1 } },
    failure: { protocol: 'assistant-skills/failure-capture-provenance/v1', provenanceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), category: 'objective-not-achieved', occurrences: 1, taskFamilyId: 'write-artifact', rollbackTarget: { name: 'saved-write', version: 1 } } })
  const firstJson = JSON.stringify(candidate)
  expect(firstJson).not.toMatch(/trigger-goal|trigger-session|trigger-native|trigger-run|repair-session|repair-native|repair-run/u)
  expect(firstJson).not.toMatch(/"(?:scope|workspace|principalId|principalRecordId|principalVersion|sessionId|nativeGoalId|runId|failureProvenance|acceptance|contractId|receiptDigest)":/u)
  await f.restart()
  const listed = result(await f.execute('skill_candidates', { candidate_id: candidate.id }))
  expect(listed).toEqual(candidate)
  expect(JSON.stringify(listed)).not.toMatch(/"(?:scope|workspace|principalId|principalRecordId|principalVersion|sessionId|nativeGoalId|runId|failureProvenance|acceptance|contractId|receiptDigest)":/u)
  const rejected = result(await f.execute('skill_reject', { candidate_id: candidate.id }))
  expect(rejected).toEqual({ ...candidate, state: 'rejected', updatedAt: rejected.updatedAt })
  expect(JSON.stringify(rejected)).not.toMatch(/trigger-goal|trigger-session|trigger-native|trigger-run|repair-session|repair-native|repair-run/u)
  expect(JSON.stringify(rejected)).not.toMatch(/"(?:scope|workspace|principalId|principalRecordId|principalVersion|sessionId|nativeGoalId|runId|failureProvenance|acceptance|contractId|receiptDigest)":/u)
  await f.restart()
  expect(result(await f.execute('skill_reject', { candidate_id: candidate.id }))).toEqual(rejected)
})

test('skill_failure_candidate consumes one atomically attested failure summary and tolerates fresh Cordis trace proxies', async () => {
  const f = await fixture(); result(await f.save())
  const state = installFailureHost(f, (read, current) => {
    if (read.kind !== 'failure') return
    const { evidence: _evidence, ...unsigned } = current.summary
    const refreshed = { ...unsigned, attestedAt: unsigned.attestedAt + read.count }
    current.summary = { ...refreshed, evidence: { ...current.summary.evidence, digest: failureSummaryEvidenceDigest(refreshed, current.generation) } }
  })
  const goals = f.ctx.get('assistantGoals')! as object
  Object.defineProperty(goals, Service.tracker, { configurable: true, value: { associate: 'assistantGoals', property: 'ctx' } })
  expect(f.ctx.get('assistantGoals')).not.toBe(f.ctx.get('assistantGoals'))
  const candidate = result(await f.execute('skill_failure_candidate', failureCandidateArgs()))
  expect(candidate).toMatchObject({ state: 'pending', failure: { protocol: 'assistant-skills/failure-capture-provenance/v1', provenanceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) } })
  expect(JSON.stringify(candidate)).not.toContain(String(state.summary.attestedAt))
  expect(state.failureReadCount()).toBe(1)
  expect(state.repairReadCount()).toBe(2)
})

test('skill_failure_candidate reports an explicit upgrade error when the Goals evidence API is unavailable', async () => {
  const f = await fixture(); result(await f.save())
  const goals = f.ctx.get('assistantGoals')! as any
  goals.inspectOwnerFailureCaptureSummary = undefined
  const response = await f.execute('skill_failure_candidate', failureCandidateArgs())
  expect(response.isError).toBe(true)
  expect(JSON.stringify(response)).toMatch(/upgrade assistant-goals to use skill_failure_candidate/u)
})

test.each(['achieved-or-unknown', 'route-drift', 'generation-drift', 'source-drift', 'evidence-digest-drift', 'cross-owner', 'cross-task', 'same-session', 'same-run', 'parent-drift'] as const)('skill_failure_candidate rejects %s evidence without staging', async kind => {
  const f = await fixture(); result(await f.save())
  const state = installFailureHost(f, read => {
    if (read.kind === 'repair' && read.count === 2) {
      if (kind === 'route-drift') f.rebindRoute()
      if (kind === 'generation-drift') state.generation = 'goals-generation-2'
      if (kind === 'source-drift') state.repair = { ...state.repair, runId: 'changed-repair-run' }
      if (kind === 'parent-drift') f.ctx.get('assistantSkills')!.save(f.owner, 'source-goal', { name: 'saved-write', description: 'Parent drift.' }, 1)
    }
    if (read.kind !== 'failure' || read.count !== 1) return
    if (kind === 'evidence-digest-drift') state.summary = { ...state.summary, attestedAt: state.summary.attestedAt + 1 }
    if (kind === 'cross-owner') state.summary = { ...state.summary, scope: { ...state.summary.scope, principalId: 'other-owner' } }
    if (kind === 'cross-task') { const objective = 'Other task'; state.summary = { ...state.summary, taskFamily: { ...state.summary.taskFamily, objective, definitionDigest: acceptanceDigest({ objective }) }, repairGoal: { ...state.summary.repairGoal, definition: { ...state.summary.repairGoal.definition, objective, digest: acceptanceDigest({ objective }) } } } }
    if (kind === 'same-session') state.summary = { ...state.summary, failures: [{ ...state.summary.failures[0]!, goal: { ...state.summary.failures[0]!.goal, sessionId: state.repair.goal.sessionId } }] }
    if (kind === 'same-run') state.summary = { ...state.summary, failures: [{ ...state.summary.failures[0]!, runId: state.repair.runId }] }
    if (['cross-owner', 'cross-task', 'same-session', 'same-run'].includes(kind)) { const { evidence: _evidence, ...unsigned } = state.summary; state.summary = { ...state.summary, evidence: { ...state.summary.evidence, digest: failureSummaryEvidenceDigest(unsigned, state.generation) } } }
  })
  if (kind === 'achieved-or-unknown') (f.ctx.get('assistantGoals')! as any).inspectOwnerFailureCaptureSummary = async () => { throw new Error('assistant-goals: exact not-achieved goal outcome is unavailable') }
  expect((await f.execute('skill_failure_candidate', failureCandidateArgs())).isError).toBe(true)
  expect(result(await f.execute('skill_candidates', {}))).toEqual([])
})

test('skill_comparison_status redacts private external receipt cells and returns only aggregate quality and public digests', async () => {
  const f = await fixture()
  const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: f.root, preset: 'primary' }
  const now = Date.now(), comparison = { id: 'comparison-redacted', sessionId: String(f.owner.session.id), candidateId: 'candidate-redacted', parentDigest: '1'.repeat(64),
    profileId: 'external:redacted:1', profileDigest: '2'.repeat(64), invocationId: 'redacted-once', state: 'complete', createdAt: now, updatedAt: now,
    result: { quality: { candidateChecksPassed: true, evaluationGain: 1, evaluationGainObserved: true, criticalRegressionsPassed: true, heldoutIndependence: 'unproven' }, admissionDigest: '3'.repeat(64),
      receipt: { planDigest: '4'.repeat(64), datasetDigest: '5'.repeat(64), publicKey: 'private-key', observationDigest: '6'.repeat(64), prospective: { generatorDigest: '7'.repeat(64) },
        cellVerdicts: [{ caseId: 'secret-case-id', armDigest: '8'.repeat(64), verdict: 'achieved' }] } } }
  const database = new DatabaseSync(join(f.root, 'skills.sqlite'))
  try { database.prepare('INSERT INTO skill_comparisons(scope_key,id,profile_id,identity_json,comparison_json,state) VALUES(?,?,?,?,?,?)')
    .run(acceptanceDigest(scope), comparison.id, comparison.profileId, JSON.stringify(comparison), JSON.stringify(comparison), comparison.state) } finally { database.close() }
  const status = result(await f.execute('skill_comparison_status', { comparison_id: comparison.id }))
  expect(status).toMatchObject({ id: comparison.id, state: 'complete', profileDigest: comparison.profileDigest, planDigest: '4'.repeat(64), datasetDigest: '5'.repeat(64), generatorDigest: '7'.repeat(64), admissionDigest: '3'.repeat(64), quality: comparison.result.quality })
  expect(JSON.stringify(status)).not.toMatch(/secret-case-id|private-key|cellVerdicts|caseId|armDigest|observationDigest|receipt/u)
  expect(status).not.toHaveProperty('sessionId')
})

test('skill_compare projects both the first result and idempotent replay through public comparison status', async () => {
  const f = await fixture(false, true, 'owner-session', 'owner-session', undefined, `sha256:${'a'.repeat(64)}`)
  result(await f.execute('skill_save', { goal_id: 'source-goal', name: 'saved-write', description: 'Write the result script.', bindings_json: '[]', expected_version: 0 }))
  f.source.steps[0]!.arguments = { file_path: 'result.sh', content: '#!/bin/sh\ncat' }
  const candidate = result(await f.execute('skill_candidate', { goal_id: 'source-goal', name: 'saved-write', description: 'Projected comparison.', bindings_json: '[]', parent_version: 1, reason: 'Audit projection.', trigger: 'owner review' }))
  const raw = { protocol: 'assistant-skills/comparison/v1', profileId: 'service-comparison', profileDigest: '1'.repeat(64), baselineDigest: '2'.repeat(64), candidateDigest: '3'.repeat(64),
    report: { complete: true, variants: [{ unknown: 0 }] }, cells: [{ caseId: 'private-case', verdict: 'achieved', publicKey: 'private-key' }],
    quality: { candidateChecksPassed: true, evaluationGain: 1, evaluationGainObserved: true, criticalRegressionsPassed: true, heldoutIndependence: 'unproven' }, promotionAuthorized: false, execution: 'native-file-tools-and-isolated-artifact', modelCalls: 0 }
  const compare = vi.spyOn(SkillComparator.prototype, 'compare').mockResolvedValue(raw as never)
  const args = { candidate_id: candidate.id, profile_id: 'service-comparison', invocation_id: 'project-local' }
  const first = result(await f.execute('skill_compare', args))
  expect(first).toMatchObject({ id: expect.stringMatching(/^skill-comparison-/u), candidateId: candidate.id, profileId: 'service-comparison', state: 'complete', quality: raw.quality })
  expect(JSON.stringify(first)).not.toMatch(/"(?:sessionId|result|report|cells|receipt|publicKey|caseId|verdict)":/u)
  const replay = result(await f.execute('skill_compare', args))
  expect(replay).toEqual(first); expect(compare).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(replay)).not.toMatch(/"(?:sessionId|result|report|cells|receipt|publicKey|caseId|verdict)":/u)
})

test('skill_qualify projects both the first result and idempotent replay through public comparison status', async () => {
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const authority = `process.stdout.write(JSON.stringify({event:'ready',protocol:'assistant-skills/holdout-ipc/v1'})+'\\n');let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);process.stdout.write(JSON.stringify({id:m.id,ok:false})+'\\n')}})`
  const f = await fixture(false, false, 'owner-session', 'owner-session', ({ root, scope }) => [{ id: 'project-external', version: 1, scope, execution: { image: `sha256:${'a'.repeat(64)}`, dockerPath: '/usr/bin/docker', stateRoot: join(tmpdir(), `assistant-skills-projected-${root.split('/').pop()}`), command: '/bin/sh /workspace/artifact', artifactPath: 'result.sh', expiresAt: Date.now() + 60_000, repeats: 2, maxToolCalls: 2, maxBytes: 4096, maxOutputBytes: 1024, cellDurationMs: 1000, verificationDurationMs: 1 }, authority: { executable: process.execPath, args: ['-e', authority], publicKey, datasetDigest: '4'.repeat(64) }, maxComparisons: 1 }])
  result(await f.save()); f.source.steps[0]!.arguments = { file: 'output.txt', data: 'candidate' }
  const candidate = result(await f.candidate(1))
  const raw = { receipt: { complete: true, sessionId: 'private-authority-session', planDigest: '5'.repeat(64), datasetDigest: '4'.repeat(64), publicKey: 'private-key', cellVerdicts: [{ caseId: 'private-case', verdict: 'achieved' }] },
    quality: { candidateChecksPassed: true, evaluationGain: 1, evaluationGainObserved: true, criticalRegressionsPassed: true, heldoutIndependence: 'unproven' }, modelCalls: 0, promotionAuthorized: false, execution: 'native-file-tools-and-isolated-artifact' }
  const qualify = vi.spyOn(HoldoutQualification, 'qualifyHoldout').mockResolvedValue(raw as never)
  const args = { candidate_id: candidate.id, profile_id: 'project-external', invocation_id: 'project-external' }
  const first = result(await f.execute('skill_qualify', args))
  expect(first).toMatchObject({ id: expect.stringMatching(/^skill-comparison-/u), candidateId: candidate.id, profileId: 'external:project-external:1', state: 'complete', planDigest: '5'.repeat(64), datasetDigest: '4'.repeat(64), quality: raw.quality })
  expect(JSON.stringify(first)).not.toMatch(/private-authority-session|private-key|private-case/u)
  expect(JSON.stringify(first)).not.toMatch(/"(?:sessionId|result|report|cells|receipt|publicKey|caseId|verdict)":/u)
  const replay = result(await f.execute('skill_qualify', args))
  expect(replay).toEqual(first); expect(qualify).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(replay)).not.toMatch(/private-authority-session|private-key|private-case/u)
  expect(JSON.stringify(replay)).not.toMatch(/"(?:sessionId|result|report|cells|receipt|publicKey|caseId|verdict)":/u)
})

test('skill_watches and skill_deployment_status return only public lifecycle projections and aggregate counts', async () => {
  const f = await fixture()
  const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: f.root, preset: 'primary' }
  const now = Date.now(), taskFamily = { goalDefinitionDigest: '1'.repeat(64), outcomeProfile: { id: 'private-outcome-profile', version: 1, digest: '2'.repeat(64) } }
  const watch = { id: 'watch-redacted', scope, routeReceipt: { authorityId: 'private-route', secretKey: 'private-route-key' }, afterRunRowId: 41, ownerRouteId: 'private-route', skillName: 'saved-write', version: 2, definitionDigest: '3'.repeat(64), fallbackVersion: 1, fallbackDigest: '4'.repeat(64), expiresAt: now + 60_000, maxRuns: 3, failureThreshold: 1, state: 'exhausted', runIds: ['private-run-one', 'private-run-two'],
    observations: [{ runId: 'private-run-one', receiptDigest: '5'.repeat(64), objectiveStatus: 'achieved', verifiedAt: now - 2, validUntil: now + 60_000, executionTraceDigest: '6'.repeat(64), taskFamilyDigest: acceptanceDigest(taskFamily) }, { runId: 'private-run-two', receiptDigest: '7'.repeat(64), objectiveStatus: 'not-achieved', verifiedAt: now - 1, validUntil: now + 60_000, executionTraceDigest: '8'.repeat(64), taskFamilyDigest: acceptanceDigest(taskFamily) }],
    createdAt: now - 10, updatedAt: now, rollbackVersion: 3, proofVersion: 'sole-skill-run/v1', taskFamily, input: { privateInput: 'watch-secret-input' }, publicKey: 'watch-private-key' }
  const deployment = { id: 'deployment-redacted', scope, candidateId: 'candidate-public', comparisonId: 'comparison-public', qualificationDigest: '9'.repeat(64), admissionDigest: 'a'.repeat(64), candidateDefinitionDigest: 'b'.repeat(64), routeReceipt: { authorityId: 'private-route', secretKey: 'deployment-route-key' }, ownerRouteId: 'private-route', skillName: 'saved-write', version: 2, definitionDigest: 'c'.repeat(64), parentVersion: 1, watchId: watch.id, taskFamily, expiresAt: now + 60_000, maxRuns: 3, canaryRuns: 2, runIds: ['private-deployment-run'], state: 'blocked', createdAt: now - 10, updatedAt: now, observations: [{ private: 'deployment-secret-observation' }], input: { privateInput: 'deployment-secret-input' }, publicKey: 'deployment-private-key' }
  const database = new DatabaseSync(join(f.root, 'skills.sqlite'))
  try {
    database.prepare('INSERT INTO skill_watches(scope_key,id,watch_json,state) VALUES(?,?,?,?)').run(acceptanceDigest(scope), watch.id, JSON.stringify(watch), watch.state)
    database.prepare('INSERT INTO skill_deployments(scope_key,id,deployment_json,state) VALUES(?,?,?,?)').run(acceptanceDigest(scope), deployment.id, JSON.stringify(deployment), deployment.state)
  } finally { database.close() }

  const watches = result(await f.execute('skill_watches', {}))
  expect(watches).toEqual([{ id: watch.id, skillName: 'saved-write', version: 2, definitionDigest: '3'.repeat(64), fallbackVersion: 1, fallbackDigest: '4'.repeat(64), expiresAt: watch.expiresAt, maxRuns: 3, failureThreshold: 1, state: 'exhausted', observedRuns: 2, achieved: 1, notAchieved: 1, createdAt: watch.createdAt, updatedAt: watch.updatedAt, rollbackVersion: 3, taskFamilyDigest: acceptanceDigest(taskFamily) }])
  const deployments = result(await f.execute('skill_deployment_status', {}))
  const expectedDeployment = { id: deployment.id, candidateId: 'candidate-public', comparisonId: 'comparison-public', qualificationDigest: '9'.repeat(64), admissionDigest: 'a'.repeat(64), candidateDefinitionDigest: 'b'.repeat(64), skillName: 'saved-write', version: 2, definitionDigest: 'c'.repeat(64), parentVersion: 1, watchId: watch.id, taskFamilyDigest: acceptanceDigest(taskFamily), expiresAt: deployment.expiresAt, maxRuns: 3, canaryRuns: 2, runCount: 1, state: 'blocked', createdAt: deployment.createdAt, updatedAt: deployment.updatedAt }
  expect(deployments).toEqual([expectedDeployment])
  expect(result(await f.execute('skill_deployment_status', { deployment_id: deployment.id }))).toEqual(expectedDeployment)
  expect(result(await f.execute('skill_deployment_status', { deployment_id: 'missing' }))).toBeNull()
  const publicJson = JSON.stringify({ watches, deployments })
  expect(publicJson).not.toMatch(/private-route|private-run|private-key|secret-input|secret-observation/u)
  expect(publicJson).not.toMatch(/"(?:scope|routeReceipt|ownerRouteId|afterRunRowId|runIds|observations|input|publicKey|proofVersion|taskFamily|receipt[^"]*)":/u)
})

test.each(['expired', 'route-revoked', 'background-revoked'] as const)('skill_canary rejects %s before opening a qualification or changing the candidate', async failure => {
  const f = await fixture(false, false, 'owner-session', 'owner-session', canaryProfile); result(await f.save())
  const candidate = result(await f.candidate(1))
  if (failure === 'route-revoked') f.revokeRoute()
  if (failure === 'background-revoked') f.denyBackground()
  const response = await f.execute('skill_canary', { candidate_id: candidate.id, profile_id: 'canary', invocation_id: `canary-${failure}`, owner_route_id: 'owner-route', expires_at: failure === 'expired' ? Date.now() - 1 : Date.now() + 30000, max_runs: 2, canary_runs: 1 })
  expect(response.isError).toBe(true)
  expect(result(await f.execute('skill_deployment_status', {}))).toEqual([])
  expect(result(await f.execute('skill_candidates', { candidate_id: candidate.id }))).toMatchObject({ state: 'pending' })
})

test('requires a human save request, and hands an active owner Goal to its first native round without claiming work', async () => {
  const f = await fixture(); f.human(false); expect((await f.save()).isError).toBe(true)
  f.human(true); result(await f.save())
  expect(result(await f.execute('skill_status', {}, f.foreign))).toEqual([])
  const runCharges = f.charges.length
  f.admitted(false); const handoff = await f.run(); expect(handoff.isError).toBe(false); expect(handoff.concludesTurn).toBe(true)
  expect(JSON.parse((handoff.value as { context: string }).context)).toMatchObject({ state: 'awaiting-native-round', performed: false, goalId: 'new-goal', invocationId: 'first' }); expect(f.count()).toBe(0)
  expect(runRows(f.root)).toBe(0); expect(f.charges).toHaveLength(runCharges)
  f.admitted(true)
  expect(result(await f.run())).toMatchObject({ state: 'succeeded' }); expect(f.count()).toBe(1)
  expect((await f.execute('skill_run', { goal_id: 'source-goal', name: 'saved-write', version: 1, invocation_id: 'bad' })).isError).toBe(true)
})

test('trial handoff concludes only for a current owner fresh Goal and later executes once in its native round', async () => {
  const f = await fixture(); const candidate = result(await f.candidate())
  const trialCharges = f.charges.length
  f.admitted(false); const handoff = await f.trial(candidate.id, 'trial-goal', 'handoff-trial')
  expect(handoff).toMatchObject({ isError: false, concludesTurn: true }); expect(JSON.parse((handoff.value as { context: string }).context)).toMatchObject({ state: 'awaiting-native-round', candidateId: candidate.id, invocationId: 'handoff-trial' }); expect(f.count()).toBe(0)
  expect(runRows(f.root)).toBe(0); expect(f.charges).toHaveLength(trialCharges)
  f.admitted(true); expect(result(await f.trial(candidate.id, 'trial-goal', 'handoff-trial'))).toMatchObject({ state: 'succeeded' }); expect(f.count()).toBe(1)
  const noOwner = await fixture(); result(await noOwner.save()); noOwner.admitted(false); noOwner.human(false)
  const denied = await noOwner.run(); expect(denied.isError).toBe(true); expect(denied.concludesTurn).not.toBe(true)
  const oldSource = await f.execute('skill_trial', { candidate_id: candidate.id, goal_id: 'source-goal', inputs_json: '{"message":"candidate"}', invocation_id: 'old-source' })
  expect(oldSource.isError).toBe(true); expect(oldSource.concludesTurn).not.toBe(true)
})

test('owner-preauthorized capture remains pending before achievement, then atomically creates one pending candidate after a cold Host source read', async () => {
  const f = await fixture()
  const capture = result(await f.execute('skill_capture', { owner_route_id: 'owner-route', goal_id: 'source-goal', name: 'captured-write', description: 'Captured successful writer.', parent_version: 0, expires_at: Date.now() + 60000 }))
  expect(capture).toEqual({ id: expect.stringMatching(/^skill-capture-/u), name: 'captured-write', parentVersion: 0, expiresAt: expect.any(Number), state: 'pending' })
  expect(JSON.stringify(capture)).not.toMatch(/"(?:scope|routeReceipt|ownerRouteId|goalId|sessionId|nativeGoalId|description|parentDigest|definitionDigest|detail|createdAt|updatedAt)":/u)
  await Promise.resolve(); await Promise.resolve()
  expect(result(await f.execute('skill_captures', {}))).toMatchObject([{ id: capture.id, state: 'pending' }])
  expect(result(await f.execute('skill_candidates', {}))).toEqual([])
  f.enableAutomaticSource(); (f.ctx.emit as (event: string, value: unknown) => void)('goal/changed', { agent: f.owner })
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  const captures = result(await f.execute('skill_captures', {})); expect(captures).toMatchObject([{ id: capture.id, state: 'captured', candidateId: expect.stringMatching(/^skill-candidate-/u) }])
  expect(JSON.stringify(captures)).not.toMatch(/"(?:scope|routeReceipt|ownerRouteId|goalId|sessionId|nativeGoalId|description|parentDigest|definitionDigest|detail|createdAt|updatedAt)":/u)
  const candidates = result(await f.execute('skill_candidates', {})); expect(candidates).toHaveLength(1); expect(candidates[0]).toMatchObject({ state: 'pending', parentVersion: 0, definition: { name: 'captured-write' } })
  await f.restart(); await Promise.resolve(); await Promise.resolve()
  expect(result(await f.execute('skill_captures', {}))).toEqual(captures)
  expect(result(await f.execute('skill_candidates', {}))).toHaveLength(1)
  expect(result(await f.execute('skill_status', {}))).toEqual([])
})

test('capture registration uses the active Goal bridge and does not require an admitted execution run', async () => {
  const f = await fixture(); f.admitted(false)
  expect(result(await f.execute('skill_capture', { owner_route_id: 'owner-route', goal_id: 'source-goal', name: 'pre-run-capture', description: 'Register before native execution.', parent_version: 0, expires_at: Date.now() + 60000 }))).toMatchObject({ state: 'pending' })
})

test('capture concludes the owner turn only after successful explicit native-round handoff', async () => {
  const args = (name: string, start_native_rounds?: boolean) => ({ owner_route_id: 'owner-route', goal_id: 'source-goal', name, description: 'Capture handoff.', parent_version: 0, expires_at: Date.now() + 60000, ...(start_native_rounds === undefined ? {} : { start_native_rounds }) })
  const immediate = await fixture(); const success = await immediate.execute('skill_capture', args('handoff-true', true)) as { isError: boolean; concludesTurn?: boolean }
  expect(success.isError).toBe(false); expect(success.concludesTurn).toBe(true)
  const defaultValue = await fixture(); const defaultResult = await defaultValue.execute('skill_capture', args('handoff-default')) as { isError: boolean; concludesTurn?: boolean }
  expect(defaultResult.isError).toBe(false); expect(defaultResult.concludesTurn).not.toBe(true)
  const explicitFalse = await fixture(); const falseResult = await explicitFalse.execute('skill_capture', args('handoff-false', false)) as { isError: boolean; concludesTurn?: boolean }
  expect(falseResult.isError).toBe(false); expect(falseResult.concludesTurn).not.toBe(true)
  const failed = await fixture(); const failedResult = await failed.execute('skill_capture', { ...args('handoff-error', true), owner_route_id: 'bad-route' }) as { isError: boolean; concludesTurn?: boolean }
  expect(failedResult.isError).toBe(true); expect(failedResult.concludesTurn).not.toBe(true)
})

test('capture binds the Session identifier internally without exposing it when the Agent identifier differs', async () => {
  const f = await fixture(false, false, 'owner-agent-id', 'owner-session-id')
  const capture = result(await f.execute('skill_capture', { owner_route_id: 'owner-route', goal_id: 'source-goal', name: 'session-bound-capture', description: 'Bind the exact session.', parent_version: 0, expires_at: Date.now() + 60000 }))
  expect(capture).toMatchObject({ name: 'session-bound-capture', state: 'pending' })
  expect(JSON.stringify(capture)).not.toContain('owner-session-id')
  expect(capture).not.toHaveProperty('sessionId')
})

test('automatic capture records an explicit unknown Goal outcome without creating a candidate', async () => {
  const f = await fixture()
  const capture = result(await f.execute('skill_capture', { owner_route_id: 'owner-route', goal_id: 'source-goal', name: 'unknown-write', description: 'Unknown capture.', parent_version: 0, expires_at: Date.now() + 60000 }))
  f.setAutomaticSourceError(); await f.restart(); await Promise.resolve(); await Promise.resolve()
  expect(result(await f.execute('skill_captures', {}))).toMatchObject([{ id: capture.id, state: 'unknown' }])
  expect(result(await f.execute('skill_candidates', {}))).toEqual([])
})

test('a late optional SessionQuery dependency nudges an unavailable cold capture without making manual skills depend on it', async () => {
  const f = await fixture(); f.requireSessionQuery(); f.enableAutomaticSource()
  const capture = result(await f.execute('skill_capture', { owner_route_id: 'owner-route', goal_id: 'source-goal', name: 'cold-query-capture', description: 'Capture after cold query startup.', parent_version: 0, expires_at: Date.now() + 60000 }))
  await Promise.resolve(); await Promise.resolve()
  expect(result(await f.execute('skill_captures', {}))).toMatchObject([{ id: capture.id, state: 'pending' }])
  f.provideSessionQuery(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(result(await f.execute('skill_captures', {}))).toMatchObject([{ id: capture.id, state: 'captured' }])
  expect(result(await f.execute('skill_candidates', {}))).toHaveLength(1)
})

test('a captured candidate reports only a failed-observation count and replays only confirmed successful steps', async () => {
  const f = await fixture(); f.addFailedReadObservation()
  const capture = result(await f.execute('skill_capture', { owner_route_id: 'owner-route', goal_id: 'source-goal', name: 'mixed-trace-write', description: 'Write after a failed read probe.', parent_version: 0, expires_at: Date.now() + 60000 }))
  f.enableAutomaticSource(); (f.ctx.emit as (event: string, value: unknown) => void)('goal/changed', { agent: f.owner })
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(result(await f.execute('skill_captures', {}))).toMatchObject([{ id: capture.id, state: 'captured' }])
  const candidate = result(await f.execute('skill_candidates', {}))[0]
  expect(candidate.definition.source).toMatchObject({ failedObservationCount: 1 })
  expect(candidate.definition.source).not.toHaveProperty('failedObservations')
  expect(candidate.definition.steps.map((step: { toolName: string }) => step.toolName)).toEqual(['write'])
  result(await f.trial(candidate.id, 'mixed-trace-trial', 'mixed-trace-once', '{}'))
  expect(f.dispatches.filter(name => name === 'read')).toEqual([])
  expect(f.count()).toBe(1)
})

test('automatic capture stops on frozen native identity, parent, route, and expiry changes', async () => {
  const create = (f: Awaited<ReturnType<typeof fixture>>, name: string) => f.execute('skill_capture', { owner_route_id: 'owner-route', goal_id: 'source-goal', name, description: 'Finite capture.', parent_version: 0, expires_at: Date.now() + 60000 })
  const native = await fixture(); result(await create(native, 'native-change')); native.source.goal.nativeGoalId = 'changed-native'; native.enableAutomaticSource(); await native.restart(); await Promise.resolve(); await Promise.resolve()
  expect(result(await native.execute('skill_captures', {}))).toMatchObject([{ state: 'revoked' }]); expect(result(await native.execute('skill_candidates', {}))).toEqual([])

  const definition = await fixture(); result(await create(definition, 'definition-change')); definition.changeAutomaticDefinition(); definition.enableAutomaticSource(); await definition.restart(); await Promise.resolve(); await Promise.resolve()
  expect(result(await definition.execute('skill_captures', {}))).toMatchObject([{ state: 'revoked' }]); expect(result(await definition.execute('skill_candidates', {}))).toEqual([])

  const parent = await fixture(); result(await create(parent, 'parent-change')); result(await parent.execute('skill_save', { goal_id: 'source-goal', name: 'parent-change', description: 'Parent change.', bindings_json: '[]', expected_version: 0 })); parent.enableAutomaticSource(); await parent.restart(); await Promise.resolve(); await Promise.resolve()
  expect(result(await parent.execute('skill_captures', {}))).toMatchObject([{ state: 'revoked' }]); expect(result(await parent.execute('skill_candidates', {}))).toEqual([])

  const route = await fixture(); result(await create(route, 'route-change')); route.enableAutomaticSource(); route.revokeRoute(); await route.restart(); await Promise.resolve(); await Promise.resolve()
  expect(result(await route.execute('skill_captures', {}))).toMatchObject([{ state: 'revoked' }]); expect(result(await route.execute('skill_candidates', {}))).toEqual([])

  const duringRead = await fixture(); result(await create(duringRead, 'route-during-read')); duringRead.enableAutomaticSource(); duringRead.holdAutomaticSource(); await duringRead.restart(); await Promise.resolve(); duringRead.revokeRoute(); duringRead.releaseAutomaticSource(); await Promise.resolve(); await Promise.resolve()
  expect(result(await duringRead.execute('skill_captures', {}))).toMatchObject([{ state: 'revoked' }]); expect(result(await duringRead.execute('skill_candidates', {}))).toEqual([])

  const expiry = await fixture(); const clock = vi.spyOn(Date, 'now'); const now = Date.now(); clock.mockReturnValue(now); result(await expiry.execute('skill_capture', { owner_route_id: 'owner-route', goal_id: 'source-goal', name: 'expired-change', description: 'Expired capture.', parent_version: 0, expires_at: now + 1000 })); clock.mockReturnValue(now + 1001); await expiry.restart(); await Promise.resolve(); await Promise.resolve()
  expect(result(await expiry.execute('skill_captures', {}))).toMatchObject([{ state: 'expired' }]); expect(result(await expiry.execute('skill_candidates', {}))).toEqual([])
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

test('activation permits only read-only metadata around one exact independently accepted trial', async () => {
  const f = await fixture(); const candidate = result(await f.candidate()); const trial = result(await f.trial(candidate.id))
  const args = { candidate_id: candidate.id, goal_id: 'trial-goal', inputs_json: '{"message":"candidate"}', invocation_id: 'trial-invocation' }
  f.setVerifiedTrialSteps('trial-goal', 'goal-execution-trial-goal', [
    { toolName: 'skill_candidates', arguments: {} }, { toolName: 'get_goal', arguments: {} },
    { toolName: 'skill_trial', arguments: args }, { toolName: 'goal_context', arguments: { goal_id: 'trial-goal', focus: false } },
    { toolName: 'skill_status', arguments: { run_id: trial.id } },
  ])
  expect(result(await f.activate(candidate.id, trial.id))).toMatchObject({ activeVersion: 1, activated: { version: 1 } })
})

test('activation rejects business, repeated, foreign, and getter metadata proof steps', async () => {
  const cases: ((candidateId: string, trialId: string, args: object) => unknown[])[] = [
    (_candidateId, _trialId, args) => [{ toolName: 'skill_trial', arguments: args }, { toolName: 'write', arguments: { file: 'x', data: 'x' } }],
    (_candidateId, _trialId, args) => [{ toolName: 'skill_trial', arguments: args }, { toolName: 'skill_trial', arguments: args }],
    (_candidateId, _trialId, args) => [{ toolName: 'skill_trial', arguments: { ...args, unexpected: true } }],
    (_candidateId, _trialId, args) => [{ toolName: 'skill_trial', arguments: args }, { toolName: 'skill_candidates', arguments: { candidate_id: 'foreign' } }],
    (_candidateId, _trialId, args) => [{ toolName: 'skill_trial', arguments: args }, { toolName: 'goal_context', arguments: { goal_id: 'trial-goal', focus: true } }],
    (_candidateId, _trialId, args) => [{ toolName: 'skill_trial', arguments: args }, { toolName: 'skill_status', arguments: Object.create(Object.prototype, { run_id: { enumerable: true, get: () => 'trial' } }) }],
  ]
  for (const steps of cases) {
    const f = await fixture(); const candidate = result(await f.candidate()); const trial = result(await f.trial(candidate.id))
    const args = { candidate_id: candidate.id, goal_id: 'trial-goal', inputs_json: '{"message":"candidate"}', invocation_id: 'trial-invocation' }
    f.setVerifiedTrialSteps('trial-goal', 'goal-execution-trial-goal', steps(candidate.id, trial.id, args))
    expect((await f.activate(candidate.id, trial.id)).isError).toBe(true)
  }
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
  expect(compared.quality).toMatchObject({ evaluationGain: 1, evaluationGainObserved: true, candidateChecksPassed: true, criticalRegressionsPassed: true })
  expect(compared).not.toHaveProperty('result')
  expect(JSON.stringify(compared)).not.toMatch(/cells|caseId|verdict|artifactDigest|jobId/u)
  expect(result(await f.execute('skill_status', {}))).toMatchObject([{ name: 'saved-write', version: 1 }])
  expect(result(await f.execute('skill_candidates', { candidate_id: candidate.id }))).toMatchObject({ state: 'pending', id: candidate.id })

  const duplicate = result(await f.execute('skill_compare', { candidate_id: candidate.id, profile_id: 'service-comparison', invocation_id: 'compare-once' }))
  expect(duplicate).toEqual(compared)
  await f.restart()
  const status = result(await f.execute('skill_comparison_status', { comparison_id: compared.id }))
  expect(status).toMatchObject({ id: compared.id, state: 'complete', candidateId: candidate.id, profileId: 'service-comparison', quality: compared.quality })
  expect(status).not.toHaveProperty('result')
  expect(JSON.stringify(status)).not.toMatch(/cells|caseId|verdict|artifactDigest|jobId/u)
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
  expect(JSON.stringify(watch)).not.toMatch(/"(?:scope|routeReceipt|ownerRouteId|afterRunRowId|runIds|observations|proofVersion|taskFamily)":/u)
  const use = async (goalId: string) => result(await f.execute('skill_run', { goal_id: goalId, name: 'saved-write', version: 2, inputs_json: '{"message":"observed"}', invocation_id: goalId }))
  const watches = async () => result(await f.execute('skill_watches', {}))
  const nudge = async () => { f.ctx.emit('assistant-verifier/receipt', { taskKind: 'goal-outcome' } as never); await new Promise<void>(resolve => setImmediate(resolve)) }
  return { ...f, watch, expiresAt, use, watches, nudge }
}

test.each(['route', 'policy', 'budget', 'late-route', 'late-policy', 'expired'] as const)('watched activation leaves the parent active when %s blocks the commit', async failure => {
  const f = await fixture(); result(await f.save())
  const candidate = result(await f.candidate(1)), trial = result(await f.trial(candidate.id))
  f.setVerifiedTrial('trial-goal', 'goal-execution-trial-goal', { candidate_id: candidate.id, goal_id: 'trial-goal', inputs_json: '{"message":"candidate"}', invocation_id: 'trial-invocation' })
  if (failure === 'route') f.revokeRoute()
  if (failure === 'policy') f.denyBackground()
  if (failure === 'budget') f.denyBudget()
  if (failure.startsWith('late-')) {
    const policy = f.ctx.get('assistantPolicy')!, original = policy.authorizeAgent.bind(policy)
    policy.authorizeAgent = (...args) => { const result = original(...args); if (args[1] === 'watch') { if (failure === 'late-route') f.rebindRoute(); else f.denyBackground() }; return result }
  }
  expect((await f.execute('skill_activate_watched', { candidate_id: candidate.id, trial_run_id: trial.id, owner_route_id: 'owner-route', expires_at: Date.now() + (failure === 'expired' ? -1 : 60000), max_runs: 2, failure_threshold: 1 })).isError).toBe(true)
  expect(result(await f.execute('skill_status', {}))[0].version).toBe(1)
  expect(result(await f.execute('skill_watches', {}))).toEqual([])
  expect(result(await f.execute('skill_candidates', { candidate_id: candidate.id })).state).toBe('pending')
})

test('watched activation from the public tool survives restart and remains observation-only after not-achieved', async () => {
  const f = await fixture(); result(await f.save())
  const candidate = result(await f.candidate(1)), trial = result(await f.trial(candidate.id))
  const args = { candidate_id: candidate.id, trial_run_id: trial.id, owner_route_id: 'owner-route', expires_at: Date.now() + 60000, max_runs: 2, failure_threshold: 1 }
  expect((await f.execute('skill_activate_watched', args)).isError).toBe(true)
  expect(result(await f.execute('skill_status', {}))[0].version).toBe(1)
  expect(result(await f.execute('skill_watches', {}))).toEqual([])
  f.setVerifiedTrial('trial-goal', 'goal-execution-trial-goal', { candidate_id: candidate.id, goal_id: 'trial-goal', inputs_json: '{"message":"candidate"}', invocation_id: 'trial-invocation' })
  const active = result(await f.execute('skill_activate_watched', args))
  expect(active).toMatchObject({ activated: { version: 2 }, watch: { version: 2, fallbackVersion: 1, state: 'watching' }, improvement: 'unmeasured' })
  expect(JSON.stringify(active)).not.toMatch(/"(?:scope|routeReceipt|ownerRouteId|afterRunRowId|runIds|observations|proofVersion|taskFamily|sessionId|nativeGoalId|runId)":/u)
  await f.restart(); f.clearVerifiedTrial()
  expect(result(await f.execute('skill_activate_watched', args))).toEqual(active)
  expect(result(await f.execute('skill_watches', {}))).toHaveLength(1)
  const run = result(await f.execute('skill_run', { goal_id: 'watched-after-activation', name: 'saved-write', version: 2, inputs_json: '{"message":"observed"}', invocation_id: 'watched-after-activation' }))
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'not-achieved'); await f.restart()
  await expect.poll(async () => result(await f.execute('skill_watches', {}))[0].observedRuns).toBe(1)
  const replay = result(await f.execute('skill_activate_watched', args))
  expect(replay).toMatchObject({ activated: { version: 2 }, activeVersion: 2, watch: { state: 'watching', observedRuns: 1, achieved: 0, notAchieved: 1 } })
  expect(JSON.stringify(replay)).not.toMatch(/"(?:scope|routeReceipt|ownerRouteId|afterRunRowId|runIds|observations|proofVersion|taskFamily|sessionId|nativeGoalId|runId)":/u)
  expect(replay.watch).not.toHaveProperty('taskFamily')
  const current = result(await f.execute('skill_status', {}))[0]
  expect(current).toMatchObject({ version: 2 }); expect(current).not.toHaveProperty('restoredFromVersion')
})

test.each(['achieved', 'not-achieved'] as const)('standalone finite watch records %s but never changes the active version', async objectiveStatus => {
  const f = await watchedFixture(1, 1); f.human(false)
  const run = await f.use(`watched-${objectiveStatus}`)
  f.setSnapshot(run.goalId, run.goalExecutionRunId, objectiveStatus)
  await f.restart()
  await expect.poll(async () => (await f.watches())[0]).toMatchObject({ state: 'exhausted', observedRuns: 1, achieved: objectiveStatus === 'achieved' ? 1 : 0, notAchieved: objectiveStatus === 'not-achieved' ? 1 : 0 })
  expect((await f.watches())[0]).not.toHaveProperty('taskFamily')
  const current = result(await f.execute('skill_status', {}))[0]
  expect(current).toMatchObject({ version: 2 }); expect(current).not.toHaveProperty('restoredFromVersion')
  await f.nudge(); await f.restart(); await f.nudge()
  expect(result(await f.execute('skill_status', {}))[0].version).toBe(2)
  expect((await f.watches())[0].observedRuns).toBe(1)
  expect(f.count()).toBe(1)
})

test.each(['wrongRun', 'wrongNative', 'unknownExecution', 'expired', 'future', 'tampered'] as const)('watch rejects %s evidence without changing the skill', async invalid => {
  const f = await watchedFixture(); const run = await f.use(`invalid-${invalid}`)
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'not-achieved', { [invalid]: true }); await f.nudge()
  expect((await f.watches())[0]).toMatchObject({ state: 'watching', observedRuns: 0, achieved: 0, notAchieved: 0 })
  expect(result(await f.execute('skill_status', {}))[0].version).toBe(2)
})

test('standalone observation-only watch becomes visibly revoked when Goals lacks run-proof support', async () => {
  const f = await watchedFixture(); const run = await f.use('missing-run-proof')
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'achieved')
  ;(f.ctx.get('assistantGoals')! as any).inspectOwnerGoalRunProof = undefined
  await f.nudge()
  expect((await f.watches())[0]).toMatchObject({ state: 'revoked', observedRuns: 0, achieved: 0, notAchieved: 0 })
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
  expect((await f.watches())[0]).toMatchObject({ state: 'watching', observedRuns: 1, achieved: 0, notAchieved: 1 })
  const second = await f.use('second-observed')
  f.setSnapshot(second.goalId, second.goalExecutionRunId, 'achieved'); await f.nudge()
  expect((await f.watches())[0]).toMatchObject({ state: 'exhausted', observedRuns: 2, achieved: 1, notAchieved: 1 })
  expect(result(await f.execute('skill_status', {}))[0].version).toBe(2)
})


test('captures an exact successful skill reuse as fixed bound steps while retaining the original source call', async () => {
  const f = await fixture()
  await f.save()
  const first = await f.run('reuse-for-capture')
  expect(first.isError).toBe(false)
  const run = JSON.parse((first.value as { context: string }).context)
  f.source.goal.id = 'new-goal'; f.source.goal.nativeGoalId = run.nativeGoalId
  f.source.goal.definition.digest = run.goalDefinitionDigest
  f.source.runId = run.goalExecutionRunId
  f.source.steps = [{ id: 'reused-call', toolName: 'skill_run', arguments: { goal_id: 'new-goal', name: 'saved-write', version: 1, inputs_json: '{"message":"reused"}', invocation_id: 'reuse-for-capture' } }] as never
  const staged = await f.execute('skill_candidate', { goal_id: 'new-goal', name: 'saved-write', description: 'Capture actual reuse.', bindings_json: '[]', parent_version: 1, reason: 'Owner review.', trigger: 'repeat' })
  expect(staged.isError).toBe(false)
  const candidate = JSON.parse((staged.value as { context: string }).context)
  expect(candidate.definition.source).toMatchObject({ stepCount: 1 })
  expect(candidate.definition.source).not.toHaveProperty('steps')
  expect(candidate.definition).toMatchObject({ runExpansionCount: 1, runExpansionsDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
  expect(candidate.definition).not.toHaveProperty('runExpansions')
  expect(candidate.definition.steps).toEqual([{ id: expect.stringMatching(/^expanded:[a-f0-9]{64}$/u), toolName: 'write', arguments: { file: 'output.txt', data: 'reused' }, dependsOn: [] }])
  expect(f.count()).toBe(1)
})
