import { Context, Service } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { canonicalEvaluationHostScope, canonicalEvaluationScope, evaluationLearningProjectionDigest } from '@dsh-enhanced/assistant-evaluation'
import { acceptanceDigest, createTaskAcceptanceContract, createTaskVerificationReceipt, goalDefinitionSituation } from '@dsh-enhanced/task-acceptance-contract'
import { SkillComparator, type SkillComparisonProfile } from '../src/comparison.ts'
import type { ExternalHoldoutProfile } from '../src/external-holdout.ts'
import { failureSummaryEvidenceDigest, type HostFailureEvidenceSummary, type VerifiedWorkflowSource } from '../src/definition.ts'
import * as HoldoutQualification from '../src/holdout-qualification.ts'
import { AssistantSkillsService, type StageSuccessCandidateInput } from '../src/service.ts'
import { SkillStore } from '../src/store.ts'

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
async function fixture(twoSteps = false, comparison = false, ownerAgentId = 'owner-session', ownerSessionId = ownerAgentId, externalHoldouts?: (input: { root: string; scope: object }) => any[], comparisonImage = image, repair = false, repairIterations = 1, repairHoldoutTtlMs = 60000) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'assistant-skills-service-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const comparisonRoot = comparison ? await realpath(await mkdtemp(join(tmpdir(), 'assistant-skills-comparison-service-'))) : undefined
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
  const canonicalOutcomes = new Map<string, any>()
  const canonicalListeners = new Set<(notice: unknown) => void>()
  let canonicalReads = 0, canonicalFences = 0, canonicalWatermark = 0
  const currentCanonical = (assessmentId: string) => {
    const value = canonicalOutcomes.get(assessmentId)
    return value && { ...structuredClone(value), scopeWatermark: canonicalWatermark }
  }
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
      acceptance: { contractId: 'trial-contract', contractDigest: 'e'.repeat(64), receiptDigest: 'f'.repeat(64), verifiedAt: source.acceptance.verifiedAt, validUntil: source.acceptance.validUntil }, steps: proof?.steps ?? [] } },
    // Successor tests install a concrete trusted failure trigger after their
    // seeded continuation reaches watching; keeping this absent holds arming.
    inspectOwnerFailureTrigger: async () => undefined,
  } as never)
  ctx.provide('assistantEvaluation' as never, {
    canonicalHostScope: (input: { workspace: string; preset: string }) => canonicalEvaluationHostScope(input),
    isTrustedTaskLearningProjectionReceipt: (value: any) => {
      try {
        const current = currentCanonical(value?.projection?.subjectRef)
        return current !== undefined && evaluationLearningProjectionDigest(value) === value.projection.digest
          && acceptanceDigest(current) === acceptanceDigest(value)
      } catch { return false }
    },
    getTrustedGoalOutcomeLearningProjection: (input: { scope: { workspace: string; preset: string }; assessmentId: string }) => {
      canonicalReads++
      const value = currentCanonical(input.assessmentId)
      return value && value.scope.workspace === input.scope.workspace && value.scope.preset === input.scope.preset ? value : undefined
    },
    withTrustedCanonicalTaskWriterFence: (input: { scope: { workspace: string; preset: string }; scopeWatermark: number; evidence: readonly { subjectKind: string; subjectRef: string; version: number; digest: string; disposition: 'upsert' | 'retract' }[] }, callback: () => unknown) => {
      canonicalFences++
      const matched = canonicalWatermark === input.scopeWatermark && input.evidence.every(expected => {
        const current = currentCanonical(expected.subjectRef)
        return current && current.scope.workspace === input.scope.workspace && current.scope.preset === input.scope.preset
          && expected.subjectKind === current.projection.subjectKind && expected.subjectRef === current.projection.subjectRef
          && expected.version === current.projection.version && expected.digest === current.projection.digest && expected.disposition === current.projection.disposition
      })
      return matched
        ? { matched: true, value: callback() } : { matched: false, reason: 'evidence-changed' }
    },
    onTrustedTaskChange: (listener: (notice: unknown) => void) => { canonicalListeners.add(listener); return () => canonicalListeners.delete(listener) },
  } as never)
  await new Promise<void>(resolve => setImmediate(resolve))
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
  const repairHoldout: ExternalHoldoutProfile = { id: 'repair-holdout', version: 1, scope,
    execution: { image: `sha256:${'b'.repeat(64)}`, dockerPath: '/usr/bin/docker', stateRoot: `${root}-holdout`, command: 'cat', artifactPath: 'artifact.sh', expiresAt: Date.now() + repairHoldoutTtlMs, repeats: 2, maxToolCalls: 4, maxBytes: 65536, maxOutputBytes: 16384, cellDurationMs: 2000, verificationDurationMs: 1000 },
    authority: { executable: process.execPath, args: [], publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest: 'c'.repeat(64) }, maxComparisons: 1,
    canaryAdmissionTemplate: { protocol: 'assistant-skills/canary-admission-template/v1', skillName: 'saved-write', taskFamily: { goalDefinitionDigest: 'd'.repeat(64), outcomeProfile: { id: 'repair-outcome', version: 1, digest: 'e'.repeat(64) } } } }
  if (repair) { ctx.provide('sessions' as never, {} as never); ctx.provide('llm' as never, {} as never) }
  const repairProfile = { scope, skillName: 'saved-write', taskFamilyId: 'repair-family', description: 'Repair saved write', externalHoldoutProfileId: 'repair-holdout', provider: 'fixture', model: 'fixture', allowedTools: ['write'], maxGoalRounds: 2, maxModelCalls: 4, maxToolCalls: 4, maxOutputTokens: 128, maxDurationMs: 30000, canaryRuns: 1, maxCanaryRuns: 2 }
  let config = { databasePath: join(root, 'skills.sqlite'), allowedTools: ['write'], ...(comparison ? { comparisons: comparisons! } : {}), ...(externalHoldouts ? { externalHoldouts: externalHoldouts({ root, scope }) } : {}), ...(repair ? { externalHoldouts: [repairHoldout], repairProfiles: [{ id: 'repair-profile', ...repairProfile, ...(repairIterations > 1 ? { maxIterations: repairIterations, followupProfileIds: ['repair-followup'] } : {}) }, ...(repairIterations > 1 ? [{ id: 'repair-followup', ...repairProfile }] : [])] } : {}) }
  let plugin = await ctx.plugin(AssistantSkillsService, config)
  await expect.poll(() => ctx.tools.get('skill_save')).toBeDefined()
  const execute = (name: string, args: unknown, agent = owner) => agent.ctx.get('tools')!.execute({ callId: ToolCallId(`call-${Math.random()}`), name, arguments: args, signal: new AbortController().signal, agent })
  const save = () => execute('skill_save', { goal_id: 'source-goal', name: 'saved-write', description: 'Write the saved artifact with a typed message.', bindings_json: JSON.stringify([{ name: 'message', stepId: 'step-1', path: '/data' }]), expected_version: 0 })
  const run = (id = 'first') => execute('skill_run', { goal_id: 'new-goal', name: 'saved-write', version: 1, inputs_json: '{"message":"reused"}', invocation_id: id })
  const candidate = (parentVersion = 0) => execute('skill_candidate', { goal_id: 'source-goal', name: 'saved-write', description: 'Candidate writer.', bindings_json: JSON.stringify([{ name: 'message', stepId: 'step-1', path: '/data' }]), parent_version: parentVersion, reason: 'Owner requested a trial.', trigger: 'manual review' })
  const trial = (candidateId: string, goalId = 'trial-goal', invocationId = 'trial-invocation', inputsJson = '{"message":"candidate"}') => execute('skill_trial', { candidate_id: candidateId, goal_id: goalId, inputs_json: inputsJson, invocation_id: invocationId })
  const activate = (candidateId: string, trialRunId: string, agent = owner) => execute('skill_activate', { candidate_id: candidateId, trial_run_id: trialRunId }, agent)
  const rollback = (expectedVersion: number, targetVersion: number) => execute('skill_rollback', { name: 'saved-write', expected_version: expectedVersion, target_version: targetVersion })
  const reviseSnapshot = (goalId: string, input: { version: number; status?: 'achieved' | 'not-achieved'; disposition?: 'upsert' | 'retract'; subjectRef?: string; lookupAssessmentId?: string; workspace?: string; principalRecordId?: string; principalVersion?: number }) => {
    const snapshot = snapshots.get(goalId) as any
    if (!snapshot) throw new Error('snapshot unavailable')
    const assessment = snapshot.outcomeAssessments[0], contract = assessment.contract
    const evaluationScope = { workspace: input.workspace ?? contract.scope.workspace, preset: contract.scope.preset }
    const scopeKey = canonicalEvaluationScope(evaluationScope).scopeKey
    const subjectRef = input.subjectRef ?? contract.task.ref, disposition = input.disposition ?? 'upsert'
    const execution = { outcomeId: `evaluation-execution-${goalId}`, status: 'succeeded' as const, source: { kind: 'evaluator' as const, id: 'assistant-verifier' },
      evidence: [{ kind: 'goal-outcome' as const, ref: subjectRef }], occurredAt: assessment.execution.completedAt, evaluator: { id: 'assistant-verifier', version: '1' } }
    const objective = disposition === 'retract' ? undefined : { outcomeId: `evaluation-objective-${goalId}-${input.version}`, status: input.status ?? 'achieved', source: { kind: input.version === 1 ? 'evaluator' as const : 'user-feedback' as const, id: input.version === 1 ? 'assistant-verifier' : 'assistant-delivery/typed-owner-feedback' },
      evidence: [{ kind: 'goal-outcome' as const, ref: subjectRef }], occurredAt: assessment.execution.completedAt, evaluator: { id: input.version === 1 ? 'assistant-verifier' : 'assistant-delivery-owner-feedback', version: input.version === 1 ? '1' : '2' } }
    const projectionBase = { subjectKind: 'goal-outcome' as const, subjectRef, disposition, ...(objective === undefined ? {} : { evidenceOutcomeId: objective.outcomeId }) }
    const situation = goalDefinitionSituation('d'.repeat(64))
    const digest = evaluationLearningProjectionDigest({ scopeKey, situation, execution, ...(objective === undefined ? {} : { objective }), projection: projectionBase })
    canonicalWatermark++
    canonicalOutcomes.set(input.lookupAssessmentId ?? subjectRef, { triggerOutcomeId: objective?.outcomeId ?? `evaluation-retract-${goalId}-${input.version}`, scope: evaluationScope, scopeKey, scopeWatermark: canonicalWatermark, situation, execution,
      ...(objective === undefined ? {} : { objective }), projection: { ...projectionBase, version: input.version, digest } })
  }
  return { root, scope, comparisonRoot, ctx, owner, foreign, save, run, execute, dispatches, lineage, charges, denyBudget: () => { budgetDenied = true }, count: () => count, human: (value: boolean) => { human = value }, admitted: (value: boolean) => { admitted = value }, deny: () => { deniedTool = true }, revokeAfterWrite: () => { revokeAfterWrite = true },
    source, candidate, trial, activate, rollback, enableAutomaticSource: () => { automaticSource = { ...source, goal: { ...source.goal, definition: { ...source.goal.definition, digest: automaticDefinitionDigest } } } }, addFailedReadObservation: () => { source.failedObservations.push({ id: 'missing-read', toolName: 'read', arguments: { file: 'missing.txt' }, outcome: 'failed' }) }, requireSessionQuery: () => { bridgeRequiresSessionQuery = true }, provideSessionQuery: () => { sessionQueryReady = true; ctx.provide('sessionQuery' as never, {} as never) }, changeAutomaticDefinition: () => { automaticDefinitionDigest = 'e'.repeat(64) }, holdAutomaticSource: () => { automaticGate = new Promise(resolve => { releaseAutomaticGate = resolve }) }, releaseAutomaticSource: () => { releaseAutomaticGate?.(); automaticGate = undefined; releaseAutomaticGate = undefined }, setAutomaticSourceError: () => { automaticSource = Object.assign(new Error('unknown outcome'), { code: 'unknown' }) }, setVerifiedTrial: (goalId: string, runId: string, args: unknown, extraSteps: unknown[] = []) => { verified = { goalId, runId, steps: [{ toolName: 'skill_trial', arguments: args }, ...extraSteps] } }, setVerifiedTrialSteps: (goalId: string, runId: string, steps: unknown[]) => { verified = { goalId, runId, steps } }, clearVerifiedTrial: () => { verified = undefined }, failVerifiedTrial: () => { verified = new Error('fixture acceptance proof expired') }, setSnapshot: (goalId: string, runId: string, status: 'achieved' | 'not-achieved', options: { expired?: boolean; validForMs?: number; wrongRun?: boolean; wrongNative?: boolean; wrongOwner?: boolean; wrongProfile?: boolean; unknownExecution?: boolean; future?: boolean; tampered?: boolean } = {}) => {
      const now = Date.now(), goal = { id: goalId, definitionVersion: 1, definitionDigest: 'd'.repeat(64), sessionId: ownerSession, nativeGoalId: options.wrongNative ? 'foreign-native' : `native-${goalId}` }
      const contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v3', id: `outcome-${goalId}`, task: { kind: 'goal-outcome', ref: `assessment-${goalId}`, goal: { ...goal, assessmentId: `assessment-${goalId}` } },
        scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: options.wrongOwner ? 'foreign-record' : 'owner-record', principalVersion: 1 }, objective: 'Check reused skill result', profile: { id: options.wrongProfile ? 'foreign-profile' : 'profile', version: 1, digest: 'a'.repeat(64) },
        criteria: [{ id: 'result', kind: 'target-readback', authority: { id: 'check', digest: 'a'.repeat(64) }, objectId: 'output', expected: [{ pointer: '/ready', value: true }] }], issuedAt: now - 1000, expiresAt: now + 60_000, bounds: { maxDurationMs: 1000, maxEvidenceBytes: 4096 } })
      const completedAt = options.expired ? now - 2 : options.future ? now + 1000 : now
      const receipt = createTaskVerificationReceipt(contract, { protocol: 'task-verification/v3', id: `receipt-${goalId}`, contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner, task: contract.task,
        results: [{ criterionId: 'result', status: status === 'achieved' ? 'passed' : 'failed', reason: 'independent-fixture-check', evidence: [] }], startedAt: completedAt, completedAt, validUntil: options.expired ? now - 1 : now + (options.validForMs ?? 60_000) })
      const execution = { status: options.unknownExecution ? 'unknown' : 'succeeded', quiescent: !options.unknownExecution, completedAt: now }
      snapshots.set(goalId, { outcome: { status }, storedGoal: { id: goalId, scope, definition: { version: 1, digest: 'd'.repeat(64) }, nativeAtLastObservation: { sessionId: ownerSession, goalId: `native-${goalId}` } },
        executionRuns: [{ intent: { runId, scope, task: { kind: 'goal-step', goal: { ...goal, nativeRevision: 1 } } }, dispatchedAt: now - 1000, execution }],
        outcomeAssessments: [{ triggerRunId: options.wrongRun ? 'wrong-run' : runId, contract, dispatchedAt: now - 1000, execution }],
        acceptedTasks: [{ contractId: contract.id, state: 'done', contract, receipt: options.tampered ? { ...receipt, digest: 'f'.repeat(64) } : receipt, verifierExecutionObservation: { ...execution, executionRef: contract.task.ref } }] })
      reviseSnapshot(goalId, { version: 1, status })
    }, denyBackground: () => { backgroundAllowed = false }, rebindRoute: () => { routeVersion++ }, revokeRoute: () => { routeLive = false },
    reviseSnapshot, snapshot: (goalId: string) => structuredClone(snapshots.get(goalId)), canonical: (assessmentId: string) => currentCanonical(assessmentId), advanceCanonicalWatermark: () => { canonicalWatermark++ }, canonicalListenerCount: () => canonicalListeners.size, canonicalReadCount: () => canonicalReads, canonicalFenceCount: () => canonicalFences,
    notifyCanonical: (assessmentId: string) => { for (const listener of canonicalListeners) listener({ subjectKind: 'goal-outcome', subjectRef: assessmentId }) },
    restart: async () => { await plugin.dispose(); plugin = await ctx.plugin(AssistantSkillsService, config); await expect.poll(() => ctx.tools.get('skill_save')).toBeDefined() },
    restartAfterDatabaseMutation: async (mutate: (database: DatabaseSync) => void) => {
      await plugin.dispose()
      const database = new DatabaseSync(join(root, 'skills.sqlite'))
      try { mutate(database) } finally { database.close() }
      plugin = await ctx.plugin(AssistantSkillsService, config)
      await expect.poll(() => ctx.tools.get('skill_save')).toBeDefined()
    },
    restartWithExternalHoldouts: async (profiles: ExternalHoldoutProfile[]) => { await plugin.dispose(); const retained = (config as { externalHoldouts?: ExternalHoldoutProfile[] }).externalHoldouts?.filter(value => value.id === 'repair-holdout') ?? []; config = { ...config, externalHoldouts: [...profiles, ...retained] }; plugin = await ctx.plugin(AssistantSkillsService, config); await expect.poll(() => ctx.tools.get('skill_save')).toBeDefined() },
    // Re-create the service with a different Host Config.allowedTools against
    // the same persisted database, exercising the constructor-frozen runtime gate.
    restartWithAllowedTools: async (allowedTools: readonly string[]) => {
      await plugin.dispose()
      config = { ...config, allowedTools: [...allowedTools] }
      plugin = await ctx.plugin(AssistantSkillsService, config)
      await expect.poll(() => ctx.tools.get('skill_save')).toBeDefined()
    } }
}
function result(value: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['run']>>) {
  expect(value.isError, JSON.stringify(value)).toBe(false)
  return JSON.parse((value.value as { context: string }).context)
}
function failureEvidence(f: Awaited<ReturnType<typeof fixture>>, locators: readonly { sessionId: string; goalId: string }[] = [{ sessionId: 'trigger-session', goalId: 'trigger-goal' }], minimumOccurrences = 1) {
  const objective = 'Write a source artifact', definition = { version: 1, digest: acceptanceDigest({ objective }), objective }, now = Date.now()
  const repair: VerifiedWorkflowSource = { ...f.source, goal: { id: 'repair-goal', definition, sessionId: 'repair-session', nativeGoalId: 'repair-native' }, runId: 'repair-run',
    acceptance: { ...f.source.acceptance, verifiedAt: now - 1_000, validUntil: now + 60_000 } }
  const unsigned = { protocol: 'assistant-skills/host-failure-evidence/v1' as const, scope: repair.scope, taskFamily: { id: 'write-artifact', definitionDigest: definition.digest, objective },
    failureCategory: minimumOccurrences >= 2 ? 'repeated-not-achieved' as const : 'objective-not-achieved' as const, triggerCondition: { kind: 'not-achieved-count' as const, minimumOccurrences, windowStartedAt: now - 2_000 - locators.length, windowEndedAt: now - 2_001 },
    failures: locators.map((locator, index) => ({ goal: { id: locator.goalId, definition, sessionId: locator.sessionId, nativeGoalId: `trigger-native-${index}` }, runId: `trigger-run-${index}`, execution: { status: 'succeeded' as const, quiescent: true as const }, outcome: 'not-achieved' as const,
      acceptance: { contractId: `failure-contract-${index}`, contractDigest: index.toString(16).padStart(64, '1').slice(-64), receiptDigest: index.toString(16).padStart(64, '2').slice(-64), verifiedAt: now - 2_000 - locators.length + index, validUntil: now + 60_000 }, traceDigest: index.toString(16).padStart(64, '3').slice(-64) })), repairGoal: repair.goal, attestedAt: now }
  const generation = 'goals-generation-1'
  const summary: HostFailureEvidenceSummary = { ...unsigned, evidence: { producer: 'assistant-goals', generation, digest: failureSummaryEvidenceDigest(unsigned, generation) } }
  return { repair, summary, generation }
}
function installFailureHost(f: Awaited<ReturnType<typeof fixture>>, mutate?: (read: { kind: 'failure' | 'repair'; count: number }, state: { repair: VerifiedWorkflowSource; summary: HostFailureEvidenceSummary; generation: string }) => void, options?: { locators: readonly { sessionId: string; goalId: string }[]; minimumOccurrences: number }) {
  const state = failureEvidence(f, options?.locators, options?.minimumOccurrences), goals = f.ctx.get('assistantGoals')! as any
  let failureReads = 0, repairReads = 0; const failureInputs: unknown[] = []
  goals.trustedAcceptanceProducerGeneration = () => state.generation
  goals.inspectOwnerFailureCaptureSummary = async (input: unknown) => { failureReads++; failureInputs.push(input); mutate?.({ kind: 'failure', count: failureReads }, state); return structuredClone(state.summary) }
  goals.inspectOwnerVerifiedWorkflowSource = async () => { repairReads++; mutate?.({ kind: 'repair', count: repairReads }, state); return structuredClone(state.repair) }
  return Object.assign(state, { failureReadCount: () => failureReads, repairReadCount: () => repairReads, failureInputs })
}
function failureCandidateArgs(extra: Record<string, unknown> = {}) {
  return Object.fromEntries(Object.entries({ owner_route_id: 'owner-route', trigger_goal_id: 'trigger-goal', trigger_session_id: 'trigger-session', repair_goal_id: 'repair-goal', repair_session_id: 'repair-session', task_family_id: 'write-artifact', name: 'saved-write', description: 'Repair writer.', bindings_json: JSON.stringify([{ name: 'message', stepId: 'step-1', path: '/data' }]), parent_version: 1, ...extra }).filter(([, value]) => value !== undefined))
}
// Engineering seam (NOT real supplier evidence): the Host-attested verified
// success producer belongs to assistant-goals; here we only install a per-
// locator table behind goals.inspectOwnerVerifiedWorkflowSource so the skills
// deposit gate can be exercised without a live owner Session.  Each locator
// gets a distinct (sessionId, goalId, runId, contractId) source sharing the
// fixture's exact owner scope; `behavior` may rewrite one read (forge, scope
// tampering, thrown errors, mid-read route rebind).
function successLocatorSet(count: number): readonly { sessionId: string; goalId: string }[] {
  return Array.from({ length: count }, (_value, index) => ({ sessionId: `sess-${index + 1}`, goalId: `goal-${index + 1}` }))
}
function installSuccessHost(f: Awaited<ReturnType<typeof fixture>>, options?: {
  locators?: readonly { sessionId: string; goalId: string }[]
  behavior?: (context: { input: { sessionId: string; goalId: string }; read: number; source: VerifiedWorkflowSource }) => VerifiedWorkflowSource | Error | void
}) {
  const locators = options?.locators ?? successLocatorSet(3)
  const sources = new Map(locators.map(locator => {
    const source: VerifiedWorkflowSource = structuredClone({ ...f.source,
      goal: { ...f.source.goal, id: locator.goalId, sessionId: locator.sessionId, nativeGoalId: `native-${locator.goalId}` },
      runId: `run-${locator.goalId}`, acceptance: { ...f.source.acceptance, contractId: `contract-${locator.goalId}` } })
    return [`${locator.sessionId}${locator.goalId}`, source] as const
  }))
  const goals = f.ctx.get('assistantGoals')! as any
  let reads = 0
  const successInputs: Array<{ ownerRouteId: string; principalId: string; workspace: string; preset: string; sessionId: string; goalId: string }> = []
  goals.inspectOwnerVerifiedWorkflowSource = async (input: typeof successInputs[number]) => {
    reads++; successInputs.push(input)
    const base = sources.get(`${input.sessionId}${input.goalId}`)
    if (!base) throw Object.assign(new Error('not completed'), { code: 'pending' })
    const override = options?.behavior?.({ input, read: reads, source: base })
    if (override instanceof Error) throw override
    return structuredClone(override ?? base)
  }
  return { locators, sourceFor: (locator: { sessionId: string; goalId: string }) => sources.get(`${locator.sessionId}${locator.goalId}`)!,
    successReadCount: () => reads, successInputs }
}
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
  const f = await fixture(); result(await f.save()); const state = installFailureHost(f)
  const parameters = f.ctx.tools.get('skill_failure_candidate')!.parameters as Record<string, unknown>
  const properties = parameters.properties as Record<string, unknown>
  expect(properties).not.toHaveProperty('summary'); expect(properties).not.toHaveProperty('provenance'); expect(properties).not.toHaveProperty('digest'); expect(properties).not.toHaveProperty('outcome')
  expect(properties.failure_locators).toMatchObject({ type: 'array', items: { type: 'object', additionalProperties: false, properties: { session_id: { type: 'string' }, goal_id: { type: 'string' } }, required: ['session_id', 'goal_id'] } })
  expect(Object.keys(((properties.failure_locators as { items: { properties: object } }).items.properties))).toEqual(['session_id', 'goal_id'])
  const candidate = result(await f.execute('skill_failure_candidate', failureCandidateArgs()))
  expect(state.failureInputs).toHaveLength(1)
  expect(state.failureInputs[0]).toMatchObject({ failures: [{ sessionId: 'trigger-session', goalId: 'trigger-goal' }], minimumOccurrences: 1 })
  expect(candidate).toMatchObject({ state: 'pending', parentVersion: 1, reason: 'Host-verified, evidence-bound repair after an independently verified failure.',
    trigger: 'host-verified-failure:objective-not-achieved',
    definition: { name: 'saved-write', source: { goalDefinitionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), stepCount: 1 } },
    failure: { category: 'objective-not-achieved', count: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/u) } })
  expect(candidate.failure).toMatchObject({ protocol: 'assistant-skills/failure-capture-provenance/v1',
    provenanceDigest: candidate.failure.digest, occurrences: 1, count: 1, taskFamilyId: 'write-artifact',
    taskFamilyDefinitionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), rollbackTarget: { name: 'saved-write', version: 1 } })
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
  expect(candidate).toMatchObject({ state: 'pending', failure: { category: 'objective-not-achieved', count: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/u) } })
  expect(JSON.stringify(candidate)).not.toContain(String(state.summary.attestedAt))
  expect(state.failureReadCount()).toBe(1)
  expect(state.repairReadCount()).toBe(2)
})

test('skill_failure_candidate canonicalizes and forwards a repeated failure locator window while redacting every locator', async () => {
  const f = await fixture(); result(await f.save())
  const locators = [{ sessionId: 'failure-session-b', goalId: 'failure-goal-b' }, { sessionId: 'failure-session-a', goalId: 'failure-goal-a' }]
  const state = installFailureHost(f, undefined, { locators, minimumOccurrences: 2 })
  const args = failureCandidateArgs({ trigger_goal_id: undefined, trigger_session_id: undefined, failure_locators: locators.map(locator => ({ session_id: locator.sessionId, goal_id: locator.goalId })), minimum_occurrences: 2 })
  const first = result(await f.execute('skill_failure_candidate', args))
  expect(state.failureInputs).toHaveLength(1)
  const forwarded = state.failureInputs[0] as { failures: { sessionId: string; goalId: string }[]; minimumOccurrences: number }
  expect(forwarded).toMatchObject({ minimumOccurrences: 2, failures: [
    { sessionId: 'failure-session-a', goalId: 'failure-goal-a' }, { sessionId: 'failure-session-b', goalId: 'failure-goal-b' },
  ] })
  expect(Object.isFrozen(forwarded.failures)).toBe(true)
  expect(forwarded.failures.every(Object.isFrozen)).toBe(true)
  expect(first).toMatchObject({ state: 'pending', trigger: 'host-verified-failure:repeated-not-achieved',
    failure: { category: 'repeated-not-achieved', count: 2, digest: expect.stringMatching(/^[a-f0-9]{64}$/u) } })
  expect(first.failure).toMatchObject({ protocol: 'assistant-skills/failure-capture-provenance/v1',
    provenanceDigest: first.failure.digest, occurrences: 2, count: 2, taskFamilyId: 'write-artifact',
    taskFamilyDefinitionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), rollbackTarget: { name: 'saved-write', version: 1 } })
  expect(JSON.stringify(first)).not.toMatch(/failure-(?:session|goal)-[ab]|trigger-native|trigger-run|repair-(?:session|native|run)/u)
  const replay = result(await f.execute('skill_failure_candidate', failureCandidateArgs({ trigger_goal_id: undefined, trigger_session_id: undefined, failure_locators: [...locators].reverse().map(locator => ({ session_id: locator.sessionId, goal_id: locator.goalId })), minimum_occurrences: 2 })))
  expect(replay).toEqual(first)
  expect(state.failureInputs).toHaveLength(2)
  expect(state.failureInputs[1]).toEqual(state.failureInputs[0])
  expect(result(await f.execute('skill_candidates', {}))).toEqual([first])
})

test.each([
  ['duplicate', [{ sessionId: 'same-session', goalId: 'same-goal' }, { sessionId: 'same-session', goalId: 'same-goal' }], 2],
  ['minimum over unique count', [{ sessionId: 'session-a', goalId: 'goal-a' }, { sessionId: 'session-b', goalId: 'goal-b' }], 3],
  ['over-bound', Array.from({ length: 33 }, (_, index) => ({ sessionId: `session-${index}`, goalId: `goal-${index}` })), 2],
  ['malformed', [{ sessionId: 'session-a', goalId: 'goal-a', outcome: 'not-achieved' }], 1],
] as const)('skill_failure_candidate rejects %s failure locator windows before a Host read', async (_kind, locators, minimumOccurrences) => {
  const f = await fixture(); result(await f.save()); const state = installFailureHost(f)
  const response = await f.execute('skill_failure_candidate', failureCandidateArgs({ trigger_goal_id: undefined, trigger_session_id: undefined, failure_locators: locators.map(locator => ({ session_id: locator.sessionId, goal_id: locator.goalId, ...('outcome' in locator ? { outcome: locator.outcome } : {}) })), minimum_occurrences: minimumOccurrences }))
  expect(response.isError).toBe(true)
  expect(state.failureReadCount()).toBe(0)
  expect(result(await f.execute('skill_candidates', {}))).toEqual([])
})

test('skill_failure_candidate rejects mixed legacy and list locators and propagates Host rejection without staging', async () => {
  const f = await fixture(); result(await f.save()); const state = installFailureHost(f)
  const listed = { failure_locators: [{ session_id: 'failure-session-a', goal_id: 'failure-goal-a' }], minimum_occurrences: 1 }
  expect((await f.execute('skill_failure_candidate', failureCandidateArgs(listed))).isError).toBe(true)
  expect(state.failureReadCount()).toBe(0)
  const goals = f.ctx.get('assistantGoals')! as any
  goals.inspectOwnerFailureCaptureSummary = async () => { throw new Error('assistant-goals: repeated failure evidence rejected') }
  expect((await f.execute('skill_failure_candidate', failureCandidateArgs({ trigger_goal_id: undefined, trigger_session_id: undefined, ...listed }))).isError).toBe(true)
  expect(result(await f.execute('skill_candidates', {}))).toEqual([])
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
      // Go through the raw service instance: ctx.get('assistantSkills') is a
      // cordis traceable Proxy whose rebound shadow `this` fails the save()
      // #private brand check, which would mask the intended parent v2 deposit.
      if (kind === 'parent-drift') (f.ctx.get('assistantSkills' as never) as any)[Symbol.for('cordis.original')].save(f.owner, 'source-goal', { name: 'saved-write', description: 'Parent drift.' }, 1)
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

test('a persisted skill is denied at run time when the Host narrows Config.allowedTools after restart', async () => {
  const f = await fixture(); result(await f.save()); f.human(false)
  expect(result(await f.run()).state).toBe('succeeded')
  // The allowlist is frozen in the constructor from Host Config, so a restart with a
  // narrower policy re-closes a skill that was previously executable.
  await f.restartWithAllowedTools([])
  const before = f.dispatches.length
  const denied = await f.run('narrowed-invocation')
  expect(denied.isError).toBe(true)
  // The :1529 allowlist throw is folded into a non-replayable failed run by the executor,
  // so assert the observable contract: failure surfaced, and the inner step was never
  // dispatched to ToolRuntime (only the outer skill_run inspection appears).
  expect(JSON.stringify(denied)).toMatch(/is failed; inspect skill_status/u)
  // The runtime gate stops the inner step before ToolRuntime dispatches it: only the
  // outer skill_run inspection is observed, never the now-unauthorized 'write'.
  expect(f.dispatches.slice(before)).toEqual(['skill_run'])
  expect(f.dispatches.slice(before)).not.toContain('write')
  // Re-opening the Host allowlist makes the same persisted definition executable again;
  // the denial came from current Host policy, not a corrupted skill.
  await f.restartWithAllowedTools(['write'])
  expect(result(await f.run('restored-invocation')).state).toBe('succeeded')
})

test('a narrowed Host allowlist rejects a fresh skill_save draft that reuses a removed tool without staging a version', async () => {
  const f = await fixture(); result(await f.save())
  await f.restartWithAllowedTools(['read'])
  const denied = await f.save()
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied)).toMatch(/untrusted tool trace/u)
  const database = new DatabaseSync(join(f.root, 'skills.sqlite'))
  try {
    const versions = (database.prepare('SELECT version, retired FROM skill_definitions WHERE scope_key=? AND name=? ORDER BY version')
      .all(acceptanceDigest(f.scope), 'saved-write') as { version: number; retired: number }[])
    expect(versions).toEqual([{ version: 1, retired: 0 }])
  } finally { database.close() }
})

test('skill_failure_candidate cannot self-grant a tool outside the frozen Host allowlist through its attested repair trace', async () => {
  const f = await fixture(); result(await f.save())
  const state = installFailureHost(f)
  // Phase A: the Host drops 'write'. The extractor reads the Host-attested repair source
  // but the draft gate rejects it because that trace reuses a tool no longer authorized.
  await f.restartWithAllowedTools([])
  const narrowed = await f.execute('skill_failure_candidate', failureCandidateArgs())
  expect(narrowed.isError).toBe(true)
  expect(JSON.stringify(narrowed)).toMatch(/untrusted tool trace/u)
  expect(state.repairReadCount()).toBe(1) // reached the draft gate after the trusted Host read
  expect(result(await f.execute('skill_candidates', {}))).toEqual([])
  // Phase B: even if a Host mistakenly names a control tool in its allowlist, controlTool
  // is a second, independent denial. The extractor submits a control trace, which is still
  // rejected; staging it can never smuggle goal_/control authority into a skill.
  state.repair = { ...state.repair, steps: [{ id: 'step-control', toolName: 'create_goal', arguments: { goal_id: 'escalate' } }] }
  await f.restartWithAllowedTools(['write', 'create_goal'])
  const control = await f.execute('skill_failure_candidate', failureCandidateArgs())
  expect(control.isError).toBe(true)
  expect(JSON.stringify(control)).toMatch(/untrusted tool trace/u)
  expect(result(await f.execute('skill_candidates', {}))).toEqual([])
  // Neither rejected trace ever reached ToolRuntime dispatch.
  expect(f.dispatches.filter(name => name === 'write' || name === 'create_goal')).toEqual([])
})

test('skill_failure_candidate records an authority-expanding permissionDelta as diagnostic only and never activates or authorizes it', async () => {
  const f = await fixture(); result(await f.save())
  const state = installFailureHost(f)
  // The live parent used only 'write'; the independently attested repair trace adds 'edit'.
  // The Host allowlist admits both, so the candidate can stage — but staging only projects.
  state.repair = { ...state.repair, steps: [
    { id: 'step-1', toolName: 'write', arguments: { file: 'output.txt', data: 'original' } },
    { id: 'step-repair-escalation', toolName: 'edit', arguments: { file: 'output.txt', data: 'repaired' } },
  ] }
  await f.restartWithAllowedTools(['write', 'edit'])
  const staged = result(await f.execute('skill_failure_candidate', failureCandidateArgs()))
  expect(staged.state).toBe('pending')
  expect(staged.parentVersion).toBe(1)
  const database = new DatabaseSync(join(f.root, 'skills.sqlite'))
  try {
    const rows = database.prepare('SELECT candidate_json FROM skill_candidates WHERE scope_key=?').all(acceptanceDigest(f.scope)) as { candidate_json: string }[]
    const candidates = rows.map(row => JSON.parse(row.candidate_json) as { failureProvenance?: { permissionDelta: unknown } })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.failureProvenance!.permissionDelta).toEqual({
      parent: ['write'], candidate: ['edit', 'write'], added: ['edit'], removed: [], expandsAuthority: true,
    })
  } finally { database.close() }
  // The expansion is recorded honestly yet grants nothing: no new live version exists, the
  // candidate stays pending for the independent owner trial/activate gates, and the added
  // tool was never dispatched during capture.
  const database2 = new DatabaseSync(join(f.root, 'skills.sqlite'))
  try {
    const versions = (database2.prepare('SELECT version, retired FROM skill_definitions WHERE scope_key=? AND name=? ORDER BY version')
      .all(acceptanceDigest(f.scope), 'saved-write') as { version: number; retired: number }[])
    expect(versions).toEqual([{ version: 1, retired: 0 }])
  } finally { database2.close() }
  expect(f.dispatches).not.toContain('edit')
  expect(result(await f.execute('skill_candidates', {}))).toEqual([staged])
})

test('a staged authority-expanding candidate cannot self-authorize its added tool at trial: the frozen current allowlist denies edit before any dispatch', async () => {
  // ENGINEERING-LAYER, NOT REAL EXTERNAL-AUTHORITY EVIDENCE: the fixture narrows the Host
  // Config.allowedTools in-process; it does not exercise a real authorization platform.
  // It closes the execution-time seam left open by the diagnostic-only test above: a
  // candidate whose attested provenance ADDS 'edit' is staged, then the CURRENT authority
  // is narrowed back to the parent tool set and the candidate is actually trialed.
  const f = await fixture(); result(await f.save())
  const state = installFailureHost(f)
  state.repair = { ...state.repair, steps: [
    { id: 'step-1', toolName: 'write', arguments: { file: 'output.txt', data: 'original' } },
    { id: 'step-repair-escalation', toolName: 'edit', arguments: { file: 'output.txt', data: 'repaired' } },
  ] }
  await f.restartWithAllowedTools(['write', 'edit'])
  const staged = result(await f.execute('skill_failure_candidate', failureCandidateArgs()))
  expect(staged).toMatchObject({ state: 'pending', parentVersion: 1 })
  // The live Host authorization is narrowed: 'edit' is no longer granted even though the
  // staged candidate still honestly records permissionDelta.added=['edit'].
  await f.restartWithAllowedTools(['write'])
  const trial = await f.trial(staged.id)
  expect(trial.isError).toBe(true)
  expect(trial.error?.message).toMatch(/is failed/u)
  // The in-authority parent step really executed once, but the added tool never reached
  // ToolRuntime: the constructor-frozen allowlist gate (service.ts) throws before
  // ctx.tools.execute('edit'), so the 'tools/execute' hook never records an edit dispatch
  // and the unregistered edit body cannot run. The recorded authority expansion is not a grant.
  expect(f.count()).toBe(1)
  expect(f.dispatches.filter(name => name === 'edit')).toEqual([])
  // A failed trial cannot activate the expansion: activate requires a succeeded run, the
  // candidate stays pending for an independent owner decision, and no new live version exists.
  const failedRun = /invocation (skill-run-[a-f0-9]+) is failed/u.exec(trial.error?.message ?? '')?.[1]
  expect(failedRun).toBeDefined()
  expect((await f.activate(staged.id, failedRun!)).isError).toBe(true)
  expect(result(await f.execute('skill_candidates', {}))).toMatchObject([{ id: staged.id, state: 'pending' }])
  const database = new DatabaseSync(join(f.root, 'skills.sqlite'))
  try {
    const versions = (database.prepare('SELECT version, retired FROM skill_definitions WHERE scope_key=? AND name=? ORDER BY version')
      .all(acceptanceDigest(f.scope), 'saved-write') as { version: number; retired: number }[])
    expect(versions).toEqual([{ version: 1, retired: 0 }])
  } finally { database.close() }
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
  const notify = () => { f.ctx.emit('assistant-verifier/receipt', { taskKind: 'goal-outcome' } as never) }
  const nudge = async () => { f.ctx.emit('assistant-verifier/receipt', { taskKind: 'goal-outcome' } as never); await new Promise<void>(resolve => setImmediate(resolve)) }
  return { ...f, watch, expiresAt, use, watches, notify, nudge }
}

async function revisionDeploymentFixture(canaryRuns = 1, maxRuns = 2, successor = false) {
  const f = successor ? await fixture(false, false, 'owner-session', 'owner-session', undefined, image, true, 2) : await fixture(), parent = result(await f.save())
  const expiresAt = Date.now() + 30_000
  if (successor) await expect.poll(() => f.ctx.tools.get('skill_repair_arm')).toBeDefined()
  const repair = successor ? f.ctx.assistantSkills.armRepair(f.owner, { goalId: 'source-goal', profileId: 'repair-profile', ownerRouteId: 'owner-route', invocationId: `successor-${Math.random()}`, expiresAt }) : undefined
  f.source.goal.definition.digest = 'd'.repeat(64)
  const candidate = result(await f.candidate(1))
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), 'assistant-skills-revision-canary-'))); await chmod(stateRoot, 0o700)
  cleanups.push(() => rm(stateRoot, { recursive: true, force: true }))
  const keys = generateKeyPairSync('ed25519')
  const taskFamily = { goalDefinitionDigest: candidate.definition.source.goalDefinitionDigest, outcomeProfile: { id: 'profile', version: 1, digest: 'a'.repeat(64) } }
  const admission = { protocol: 'assistant-skills/canary-admission/v1' as const, skillName: 'saved-write', parentDefinitionDigest: acceptanceDigest(parent), candidateDefinitionDigest: candidate.definitionDigest, taskFamily }
  const profile: ExternalHoldoutProfile = { id: 'revision-canary', version: 1, scope: { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: f.root, preset: 'primary' },
    execution: { image: `sha256:${'a'.repeat(64)}`, dockerPath: '/usr/bin/docker', stateRoot, command: '/bin/sh /workspace/artifact', artifactPath: 'artifact', expiresAt: Date.now() + 120_000, repeats: 2, maxToolCalls: 2, maxBytes: 4096, maxOutputBytes: 1024, cellDurationMs: 1000, verificationDurationMs: 1 },
    authority: { executable: process.execPath, args: ['-e', "process.stdout.write(JSON.stringify({event:'ready',protocol:'assistant-skills/holdout-ipc/v1'})+'\\n');process.stdin.resume();setInterval(()=>{},1000)"], publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest: '9'.repeat(64) },
    canaryAdmission: admission, maxComparisons: 1 }
  const store = new SkillStore(join(f.root, 'skills.sqlite'))
  const storedCandidate = store.getCandidate(profile.scope, candidate.id)!
  const comparison = store.claimComparison(profile.scope, { sessionId: String(f.owner.session.id), candidateId: candidate.id, parentDigest: storedCandidate.parentDigest!, profileId: `external:${profile.id}:${profile.version}`, profileDigest: acceptanceDigest(profile), invocationId: 'revision-qualification' }, 1).comparison
  const qualification = { qualified: true, admissionDigest: acceptanceDigest(admission) }
  store.finishComparison(profile.scope, comparison.id, 'complete', qualification)
  const activated = store.activateQualifiedCandidate(profile.scope, candidate.id, comparison.id, acceptanceDigest(qualification), admission,
    { ownerRouteId: 'owner-route', expiresAt, maxRuns, canaryRuns }, { authorityId: 'owner-route', principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: f.root, agentPreset: 'primary', bindingVersion: 1, generation: 1 })
  store.close()
  if (repair) await seedRepairWatching({ root: f.root, scope: f.scope, repair, candidateId: candidate.id, deployed: activated })
  vi.spyOn(HoldoutQualification, 'inspectProspectiveQualification').mockReturnValue({
    receipt: { complete: true }, quality: { candidateChecksPassed: true, evaluationGain: 1, evaluationGainObserved: true, criticalRegressionsPassed: true, heldoutIndependence: 'unproven' },
    modelCalls: 0, promotionAuthorized: false, execution: 'native-file-tools-and-isolated-artifact', prospectiveHoldout: 'authority-attested-after-freeze', admissionDigest: acceptanceDigest(admission),
  } as never)
  await f.restartWithExternalHoldouts([profile])
  await expect.poll(f.canonicalListenerCount).toBe(1)
  const use = async (goalId: string) => result(await f.execute('skill_run', { goal_id: goalId, name: 'saved-write', version: 2, inputs_json: '{"message":"observed"}', invocation_id: goalId }))
  const watches = async () => result(await f.execute('skill_watches', {}))
  const deployment = async () => result(await f.execute('skill_deployment_status', { deployment_id: activated.deployment.id }))
  return { ...f, profile, taskFamily, deployed: activated, repair, use, watches, deployment }
}

async function seedRepairWatching(f: { root: string; scope: object; repair: { id: string }; candidateId: string; deployed: { deployment: { id: string } } }) {
  const store = new SkillStore(join(f.root, 'skills.sqlite'))
  try {
    let record = store.getRepairContinuation(f.scope, f.repair.id)!
    const advance = (state: Parameters<SkillStore['transitionRepairContinuation']>[3], checkpoint: Record<string, unknown>) => {
      record = store.transitionRepairContinuation(f.scope, record.id, record.revision, state, checkpoint)
    }
    advance('source-confirmed', {})
    advance('creating-repair', {})
    const repair = { sessionId: 'repair-session', goalId: 'repair-goal' }
    advance('repairing', { repair })
    advance('repair-achieved', { repair })
    advance('capturing', { repair })
    advance('candidate-staged', { repair })
    advance('comparing', { repair })
    advance('watching', { repair, candidateId: f.candidateId, deploymentId: f.deployed.deployment.id })
    return record
  } finally { store.close() }
}

function installSuccessorTrigger(f: Awaited<ReturnType<typeof revisionDeploymentFixture>>, run: { goalId: string }) {
  ;(f.ctx.get('assistantGoals')! as any).inspectOwnerFailureTrigger = async () => ({
    protocol: 'assistant-skills/host-failure-trigger/v1', scope: f.scope,
    taskFamily: { id: 'repair-family', definitionDigest: 'd'.repeat(64), objective: 'Repair saved write' },
    failures: [{ goal: { id: run.goalId, sessionId: String(f.owner.session.id), nativeGoalId: `native-${run.goalId}` } }],
    triggerCondition: { minimumOccurrences: 1 }, evidence: { digest: 'trigger' },
  })
}

async function promoteRevisionDeployment(f: Awaited<ReturnType<typeof revisionDeploymentFixture>>, run: { goalId: string; goalExecutionRunId: string }) {
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'achieved')
  f.notifyCanonical(`assessment-${run.goalId}`)
  await expect.poll(f.deployment).toMatchObject({ state: 'promoted' })
}

test.each(['successor', 'revocation'] as const)('deployment reconciliation distinguishes %s before checking old authority', async change => {
  const f = await revisionDeploymentFixture()
  await promoteRevisionDeployment(f, await f.use(`reconcile-${change}`))
  const store = new SkillStore(join(f.root, 'skills.sqlite'))
  try {
    const promotedAt = store.getDeployment(f.scope, f.deployed.deployment.id)!.promotedAt
    if (change === 'successor') {
      const successor = result(await f.execute('skill_save', { goal_id: 'source-goal', name: 'saved-write', description: 'A later owner-authorized version.', expected_version: 2, bindings_json: '[]' }))
      expect(successor.version).toBe(3)
    } else f.revokeRoute()
    f.ctx.emit('assistant-verifier/receipt', { taskKind: 'goal-outcome' } as never)
    await expect.poll(() => store.getDeployment(f.scope, f.deployed.deployment.id)?.state, { timeout: 3_000 }).toBe(change === 'successor' ? 'superseded' : 'revoked')
    expect(store.getDeployment(f.scope, f.deployed.deployment.id)?.promotedAt).toBe(promotedAt)
  } finally { store.close() }
})

test('repair successor ignores a matching run created before or at predecessor promotion', async () => {
  const f = await revisionDeploymentFixture(1, 2, true), at = Date.now()
  if (!f.repair) throw new Error('successor repair fixture unavailable')
  vi.spyOn(Date, 'now').mockReturnValue(at)
  const run = await f.use('successor-at-promotion')
  await promoteRevisionDeployment(f, run)
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'not-achieved')
  installSuccessorTrigger(f, run)
  await new Promise(resolve => setTimeout(resolve, 1_100))
  expect(f.ctx.assistantSkills.repairStatus(f.owner, f.repair.id)).toMatchObject({ state: 'watching', iteration: 1 })
})

test('repair successor fails closed for a legacy promoted deployment without promotedAt', async () => {
  const f = await revisionDeploymentFixture(1, 2, true)
  if (!f.repair) throw new Error('successor repair fixture unavailable')
  const run = await f.use('successor-legacy-promotion')
  await promoteRevisionDeployment(f, run)
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'not-achieved')
  installSuccessorTrigger(f, run)
  const original = SkillStore.prototype.getDeployment
  vi.spyOn(SkillStore.prototype, 'getDeployment').mockImplementation(function (this: SkillStore, scope, id) {
    const deployment = original.call(this, scope, id)
    if (deployment?.id !== f.deployed.deployment.id) return deployment
    const { promotedAt: _promotedAt, ...legacy } = deployment
    return legacy
  })
  await new Promise(resolve => setTimeout(resolve, 1_100))
  expect(f.ctx.assistantSkills.repairStatus(f.owner, f.repair.id)).toMatchObject({ state: 'watching', iteration: 1 })
})

test('repair successor enters iteration two only for a matching run after predecessor promotion', async () => {
  const f = await revisionDeploymentFixture(1, 2, true)
  if (!f.repair) throw new Error('successor repair fixture unavailable')
  const repairId = f.repair.id
  const canary = await f.use('successor-promote')
  await promoteRevisionDeployment(f, canary)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10)
  const run = await f.use('successor-after-promotion')
  const store = new SkillStore(join(f.root, 'skills.sqlite'))
  try { expect(store.repairSourceRuns(f.scope, 'saved-write', 2, store.getDeployment(f.scope, f.deployed.deployment.id)!.promotedAt!).map(value => value.id)).toContain(run.id) } finally { store.close() }
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'not-achieved')
  installSuccessorTrigger(f, run)
  await expect.poll(() => f.ctx.assistantSkills.repairStatus(f.owner, repairId), { timeout: 3_000 }).toMatchObject({ iteration: 2, state: 'armed' })
})

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

test('watch replaces a recorded outcome with the latest canonical revision across duplicate notices and restart', async () => {
  const f = await revisionDeploymentFixture(), run = await f.use('revision-aware')
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'achieved')
  const direct = (await import('../src/watch-proof.ts')).watchObservationResult(f.snapshot(run.goalId) as never, f.profile.scope,
    result(await f.execute('skill_status', { run_id: run.id })) as never, Date.now(),
    await (f.ctx.get('assistantGoals')! as any).inspectOwnerGoalRunProof({ goalId: run.goalId, runId: run.goalExecutionRunId }), f.taskFamily, f.canonical(`assessment-${run.goalId}`),
    (value: any) => evaluationLearningProjectionDigest(value) === value.projection.digest)
  expect(direct).toMatchObject({ kind: 'current', observation: { objectiveStatus: 'achieved' } })
  f.notifyCanonical(`assessment-${run.goalId}`); f.notifyCanonical(`assessment-${run.goalId}`)
  await expect.poll(f.canonicalReadCount).toBeGreaterThan(0)
  await expect.poll(f.canonicalFenceCount).toBeGreaterThan(0)
  await expect.poll(async () => (await f.watches())[0]).toMatchObject({ state: 'watching', observedRuns: 1, achieved: 1, notAchieved: 0 })
  await expect.poll(f.deployment).toMatchObject({ state: 'promoted' })

  // The verifier receipt stays achieved; a newer canonical owner correction
  // must replace it instead of being rejected as a duplicate run.
  f.reviseSnapshot(run.goalId, { version: 2, status: 'not-achieved' })
  f.notifyCanonical(`assessment-${run.goalId}`); f.notifyCanonical(`assessment-${run.goalId}`); await new Promise<void>(resolve => setImmediate(resolve))
  await expect.poll(f.deployment).toMatchObject({ state: 'rolled-back' })
  expect((await f.watches())[0]).toMatchObject({ state: 'rolled-back', observedRuns: 1, achieved: 0, notAchieved: 1, rollbackVersion: 3 })
  await f.restartWithExternalHoldouts([f.profile]); f.notifyCanonical(`assessment-${run.goalId}`); await new Promise<void>(resolve => setImmediate(resolve))
  expect(await f.deployment()).toMatchObject({ state: 'rolled-back' })
  expect(result(await f.execute('skill_status', {}))[0]).toMatchObject({ version: 3, restoredFromVersion: 1 })
})

test('service restart quarantines a legacy promoted deployment before claim or native tool dispatch', async () => {
  const f = await revisionDeploymentFixture(), run = await f.use('legacy-migration')
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'achieved')
  f.notifyCanonical(`assessment-${run.goalId}`)
  await expect.poll(f.deployment).toMatchObject({ state: 'promoted' })
  const rowsBefore = runRows(f.root), writesBefore = f.dispatches.filter(name => name === 'write').length

  await f.restartAfterDatabaseMutation(database => {
    database.prepare("UPDATE skill_watches SET watch_json=json_remove(json_set(watch_json, '$.proofVersion', 'sole-skill-run/v1'), '$.canonicalRevisions', '$.observations[0].canonical') WHERE id=?")
      .run(f.deployed.deployment.watchId)
  })

  await expect.poll(f.deployment).toMatchObject({ state: 'blocked' })
  const denied = await f.execute('skill_run', { goal_id: 'legacy-migration-denied', name: 'saved-write', version: 2, inputs_json: '{"message":"must-not-run"}', invocation_id: 'legacy-migration-denied' })
  expect(denied.isError).toBe(true)
  expect(runRows(f.root)).toBe(rowsBefore)
  expect(f.dispatches.filter(name => name === 'write')).toHaveLength(writesBefore)
  expect(f.count()).toBe(1)
  await f.restartWithExternalHoldouts([f.profile])
  expect(await f.deployment()).toMatchObject({ state: 'blocked' })
})

test('a newer positive canonical revision remains promoted and never rolls back', async () => {
  const f = await revisionDeploymentFixture(), run = await f.use('revision-positive')
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'achieved'); f.notifyCanonical(`assessment-${run.goalId}`)
  await expect.poll(async () => (await f.watches())[0]).toMatchObject({ observedRuns: 1, achieved: 1 })
  await expect.poll(f.deployment).toMatchObject({ state: 'promoted' })
  f.reviseSnapshot(run.goalId, { version: 2, status: 'achieved' })
  f.notifyCanonical(`assessment-${run.goalId}`); f.notifyCanonical(`assessment-${run.goalId}`)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(await f.deployment()).toMatchObject({ state: 'promoted' })
  expect((await f.watches())[0]).toMatchObject({ state: 'watching', observedRuns: 1, achieved: 1, notAchieved: 0 })
  await f.restartWithExternalHoldouts([f.profile]); f.notifyCanonical(`assessment-${run.goalId}`); await new Promise<void>(resolve => setImmediate(resolve))
  expect(await f.deployment()).toMatchObject({ state: 'promoted' })
  expect(result(await f.execute('skill_status', {}))[0]).toMatchObject({ version: 2 })
})

test('concurrent canonical revisions cannot commit a stale first read', async () => {
  const f = await revisionDeploymentFixture(), run = await f.use('revision-race')
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'achieved')
  const stale = f.snapshot(run.goalId)
  const staleCanonical = f.canonical(`assessment-${run.goalId}`)
  f.reviseSnapshot(run.goalId, { version: 2, status: 'not-achieved' })
  const latest = f.snapshot(run.goalId)
  const latestCanonical = f.canonical(`assessment-${run.goalId}`)
  let reads = 0, canonicalReads = 0
  ;(f.ctx.get('assistantGoals')! as any).inspectOwnerGoalExecution = () => structuredClone(++reads === 1 ? stale : latest)
  ;(f.ctx.get('assistantEvaluation')! as any).getTrustedGoalOutcomeLearningProjection = () => structuredClone(++canonicalReads === 1 ? staleCanonical : latestCanonical)
  f.notifyCanonical(`assessment-${run.goalId}`); f.notifyCanonical(`assessment-${run.goalId}`)
  await expect.poll(f.deployment).toMatchObject({ state: 'rolled-back' })
  expect((await f.watches())[0]).toMatchObject({ observedRuns: 1, achieved: 0, notAchieved: 1 })
  expect(reads).toBeGreaterThanOrEqual(2)
})

test('unrelated scope watermark advancement does not poison unchanged canary evidence', async () => {
  const f = await revisionDeploymentFixture(2, 2)
  const first = await f.use('revision-watermark-first')
  f.setSnapshot(first.goalId, first.goalExecutionRunId, 'achieved'); f.notifyCanonical(`assessment-${first.goalId}`)
  await expect.poll(async () => (await f.watches())[0]).toMatchObject({ observedRuns: 1, achieved: 1 })
  await expect.poll(f.deployment).toMatchObject({ state: 'canary' })
  f.advanceCanonicalWatermark()

  const second = await f.use('revision-watermark-second')
  f.setSnapshot(second.goalId, second.goalExecutionRunId, 'achieved'); f.notifyCanonical(`assessment-${second.goalId}`)
  await expect.poll(async () => (await f.watches())[0]).toMatchObject({ observedRuns: 2, achieved: 2, notAchieved: 0 })
  await expect.poll(f.deployment).toMatchObject({ state: 'promoted' })
})

test.each([
  ['not-achieved', { status: 'not-achieved' as const }, { observedRuns: 1, achieved: 0, notAchieved: 1 }],
  ['retract', { disposition: 'retract' as const }, { observedRuns: 0, achieved: 0, notAchieved: 0 }],
] as const)('two-run promotion is fenced when the first canonical outcome changes to %s between aggregate read and commit', async (_change, correction, finalCounts) => {
  const f = await revisionDeploymentFixture(2, 2)
  const first = await f.use(`revision-fence-first-${_change}`)
  f.setSnapshot(first.goalId, first.goalExecutionRunId, 'achieved'); f.notifyCanonical(`assessment-${first.goalId}`)
  await expect.poll(async () => (await f.watches())[0]).toMatchObject({ observedRuns: 1, achieved: 1 })
  await expect.poll(f.deployment).toMatchObject({ state: 'canary' })

  const second = await f.use(`revision-fence-second-${_change}`)
  f.setSnapshot(second.goalId, second.goalExecutionRunId, 'achieved')
  const evaluation = f.ctx.get('assistantEvaluation')! as any
  const fence = evaluation.withTrustedCanonicalTaskWriterFence.bind(evaluation)
  let raced = false
  evaluation.withTrustedCanonicalTaskWriterFence = (input: any, callback: () => unknown) => {
    if (!raced && input.evidence.length === 2) {
      raced = true
      f.reviseSnapshot(first.goalId, { version: 2, ...correction })
    }
    return fence(input, callback)
  }
  f.notifyCanonical(`assessment-${second.goalId}`)
  await expect.poll(() => raced).toBe(true)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(await f.deployment()).toMatchObject({ state: 'canary' })
  expect((await f.watches())[0]).toMatchObject({ observedRuns: 1, achieved: 1, notAchieved: 0 })

  f.notifyCanonical(`assessment-${first.goalId}`)
  await expect.poll(f.deployment).toMatchObject({ state: 'rolled-back' })
  expect((await f.watches())[0]).toMatchObject({ state: 'rolled-back', ...finalCounts, rollbackVersion: 3 })
})

test('watch invalidates a withdrawn canonical outcome durably and does not resurrect it after restart', async () => {
  const f = await revisionDeploymentFixture(), run = await f.use('revision-withdrawn')
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'achieved'); f.notifyCanonical(`assessment-${run.goalId}`)
  await expect.poll(async () => (await f.watches())[0]).toMatchObject({ observedRuns: 1, achieved: 1 })
  await expect.poll(f.deployment).toMatchObject({ state: 'promoted' })
  expect((await f.watches())[0]).toMatchObject({ observedRuns: 1, achieved: 1 })
  f.reviseSnapshot(run.goalId, { version: 2, disposition: 'retract' }); f.notifyCanonical(`assessment-${run.goalId}`); await new Promise<void>(resolve => setImmediate(resolve))
  await expect.poll(f.deployment).toMatchObject({ state: 'rolled-back' })
  expect((await f.watches())[0]).toMatchObject({ state: 'rolled-back', observedRuns: 0, achieved: 0, notAchieved: 0, rollbackVersion: 3 })
  await f.restartWithExternalHoldouts([f.profile]); f.notifyCanonical(`assessment-${run.goalId}`); f.notifyCanonical(`assessment-${run.goalId}`); await new Promise<void>(resolve => setImmediate(resolve))
  expect((await f.watches())[0]).toMatchObject({ state: 'rolled-back', observedRuns: 0, achieved: 0, notAchieved: 0, rollbackVersion: 3 })
  expect(result(await f.execute('skill_status', {}))[0]).toMatchObject({ version: 3, restoredFromVersion: 1 })
})

test.each([
  ['wrong run', { canonical: { subjectRef: 'foreign-assessment', lookupAssessmentId: 'assessment-revision-wrong-run' } }],
  ['wrong owner', { snapshot: { wrongOwner: true } }],
  ['wrong profile', { snapshot: { wrongProfile: true } }],
] as const)('watch rejects a newer canonical revision for the %s without replacing accepted evidence', async (_name, invalid) => {
  const f = await revisionDeploymentFixture(), run = await f.use(`revision-${_name.replace(' ', '-')}`)
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'achieved')
  f.notifyCanonical(`assessment-${run.goalId}`)
  await expect.poll(async () => (await f.watches())[0]).toMatchObject({ observedRuns: 1, achieved: 1 })
  await expect.poll(f.deployment).toMatchObject({ state: 'promoted' })
  if ('snapshot' in invalid) f.setSnapshot(run.goalId, run.goalExecutionRunId, 'achieved', invalid.snapshot)
  f.reviseSnapshot(run.goalId, { version: 2, status: 'not-achieved', ...('canonical' in invalid ? invalid.canonical : {}) })
  f.notifyCanonical(`assessment-${run.goalId}`); await new Promise<void>(resolve => setImmediate(resolve))
  expect((await f.watches())[0]).toMatchObject({ state: 'watching', observedRuns: 1, achieved: 1, notAchieved: 0 })
  expect(await f.deployment()).toMatchObject({ state: 'promoted' })
  expect(result(await f.execute('skill_status', {}))[0]).toMatchObject({ version: 2 })
})

test('a later canonical correction can roll back after the originally bound verifier receipt expires', async () => {
  const f = await revisionDeploymentFixture(), run = await f.use('revision-after-expiry')
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now)
  f.setSnapshot(run.goalId, run.goalExecutionRunId, 'achieved', { validForMs: 10 })
  f.notifyCanonical(`assessment-${run.goalId}`)
  await expect.poll(async () => (await f.watches())[0]).toMatchObject({ observedRuns: 1, achieved: 1 })
  await expect.poll(f.deployment).toMatchObject({ state: 'promoted' })
  now += 11
  f.reviseSnapshot(run.goalId, { version: 2, status: 'not-achieved' })
  f.notifyCanonical(`assessment-${run.goalId}`)
  await expect.poll(f.deployment).toMatchObject({ state: 'rolled-back' })
  expect((await f.watches())[0]).toMatchObject({ state: 'rolled-back', observedRuns: 1, achieved: 0, notAchieved: 1, rollbackVersion: 3 })
  expect(result(await f.execute('skill_status', {}))[0]).toMatchObject({ version: 3, restoredFromVersion: 1 })
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

test('finite repair arming requires a live human request and exact immutable replay, and survives restart without dispatch', async () => {
  const f = await fixture(false, false, 'owner-session', 'owner-session', undefined, image, true)
  await f.save()
  const input = { goalId: 'failed-goal', profileId: 'repair-profile', ownerRouteId: 'owner-route', invocationId: 'repair-once', expiresAt: Date.now() + 30000 }
  f.human(false)
  expect(() => f.ctx.assistantSkills.armRepair(f.owner, input)).toThrow(/current owner request/)
  f.human(true)
  const armed = f.ctx.assistantSkills.armRepair(f.owner, input)
  expect(armed).toMatchObject({ state: 'armed', maxIterations: 1 })
  expect(f.ctx.assistantSkills.armRepair(f.owner, input).id).toBe(armed.id)
  expect(() => f.ctx.assistantSkills.armRepair(f.owner, { ...input, expiresAt: input.expiresAt + 1 })).toThrow(/conflict/)
  f.human(false)
  expect(f.ctx.assistantSkills.repairStatus(f.owner, armed.id)).toMatchObject({ state: 'armed' })
  await f.restart()
  expect(f.ctx.assistantSkills.repairStatus(f.owner, armed.id)).toMatchObject({ state: 'armed', maxIterations: 1, expiresAt: input.expiresAt })
  f.human(true)
  expect(await f.ctx.assistantSkills.revokeRepair(f.owner, armed.id)).toMatchObject({ state: 'revoked' })
  await f.restart()
  expect(f.ctx.assistantSkills.repairStatus(f.owner, armed.id)).toMatchObject({ state: 'revoked' })
})

test('repair rejects expired authorization, exposes only scoped configuration, and denies fabricated execution capability', async () => {
  const f = await fixture(false, false, 'owner-session', 'owner-session', undefined, image, true)
  await f.save()
  const input = { goalId: 'failed-goal', profileId: 'repair-profile', ownerRouteId: 'owner-route', invocationId: 'repair-once', expiresAt: Date.now() - 1 }
  expect(() => f.ctx.assistantSkills.armRepair(f.owner, input)).toThrow(/finite/)
  const status = f.ctx.assistantSkills.repairStatus(f.owner)
  expect(status).toMatchObject({ profiles: [{ id: 'repair-profile', maxIterations: 1 }], continuations: [] })
  expect(JSON.stringify(status)).not.toContain('generatorDigest')
  expect(f.ctx.assistantSkills.ownsOwnerAuthorizedRepair({ authorizationId: 'fake' } as never, () => {})).toBe(false)
})

// ENGINEERING-LAYER BOUNDARY TEST, NOT REAL EXTERNAL-AUTHORITY EVIDENCE:
// inputs_json/bindings_json are raw model-controlled tool-argument strings.
// `parse()` (service.ts:51) is the 256 KiB fail-closed gate shared by
// skill_save/skill_run/skill_candidate/skill_failure_candidate/skill_trial.
// It is evaluated while building this.run()/this.save()'s arguments, so it
// throws before any lookup or dispatch; an oversized payload must never turn
// into a run row or a delegated native tool call.
test('model-facing skill tools fail closed on unbounded or malformed JSON arguments before any run', async () => {
  const f = await fixture()
  const oversizedObject = 'x'.repeat(262145)
  const serviceError = /bounded JSON required|invalid JSON shape/u
  const serviceRejected: Array<[string, string, Record<string, unknown>]> = [
    ['skill_run oversized inputs_json', 'skill_run', { goal_id: 'g', name: 'saved-write', version: 1, inputs_json: oversizedObject, invocation_id: 'i' }],
    ['skill_save oversized bindings_json', 'skill_save', { goal_id: 'g', name: 'n', description: 'd', bindings_json: `[${oversizedObject}]`, expected_version: 0 }],
    ['skill_run at the inclusive 256 KiB bound still parses as an object', 'skill_run', { goal_id: 'g', name: 'saved-write', version: 1, inputs_json: `{"x":"${'y'.repeat(262144 - 8)}"}`, invocation_id: 'i' }],
    ['skill_run array where an object is required', 'skill_run', { goal_id: 'g', name: 'n', version: 1, inputs_json: '[]', invocation_id: 'i' }],
    ['skill_save object where an array is required', 'skill_save', { goal_id: 'g', name: 'n', description: 'd', bindings_json: '{}', expected_version: 0 }],
  ]
  for (const [label, tool, args] of serviceRejected) {
    if (label.startsWith('skill_run at the inclusive')) {
      // Exactly 262144 bytes passes the byte gate; it then fails later on the
      // absent saved skill, which is a different (domain) error, never the
      // bounded-JSON gate. This pins the gate's boundary is >, not >=.
      const atBound = await f.execute(tool, args)
      expect(atBound.isError, `${label}: ${JSON.stringify(atBound)}`).toBe(true)
      expect(JSON.stringify(atBound)).not.toMatch(serviceError)
      continue
    }
    const response = await f.execute(tool, args)
    expect(response.isError, `${label}: ${JSON.stringify(response)}`).toBe(true)
    expect(JSON.stringify(response), label).toMatch(serviceError)
  }
  // A non-string JSON field is stopped one layer earlier by the tool-schema
  // type gate (before execute()/parse() runs); it is equally fail-closed.
  const wrongType = await f.execute('skill_run', { goal_id: 'g', name: 'n', version: 1, inputs_json: { x: 1 }, invocation_id: 'i' })
  expect(wrongType.isError).toBe(true)
  expect(JSON.stringify(wrongType)).toMatch(/must be a string/u)
  // A syntactically malformed string also fails closed (a JSON.parse SyntaxError).
  const malformed = await f.execute('skill_run', { goal_id: 'g', name: 'n', version: 1, inputs_json: '{not json', invocation_id: 'i' })
  expect(malformed.isError).toBe(true)
  // The oversized skill_run never reached dispatch: no run row, no write tool.
  expect(runRows(f.root)).toBe(0)
  expect(f.dispatches).not.toContain('write')
})

test('skill_watch fails closed on model-supplied finite-window bounds outside the store gates', async () => {
  // ENGINEERING-LAYER FAIL-CLOSED CONTRACT TEST, NOT REAL EXTERNAL-AUTHORITY
  // EVIDENCE: expires_at/max_runs/failure_threshold are model-written tool
  // arguments on the public skill_watch tool, fully reachable through the real
  // tool path. The store's #createWatch is the single fail-closed gate that
  // keeps a watch finite (past/future 7-day expiry, 1..100 runs, threshold<=runs).
  const f = await fixture()
  result(await f.save())
  result(await f.execute('skill_save', { goal_id: 'source-goal', name: 'saved-write', description: 'Second version', bindings_json: JSON.stringify([{ name: 'message', stepId: 'step-1', path: '/data' }]), expected_version: 1 }))
  const base = { owner_route_id: 'owner-route', name: 'saved-write', version: 2, fallback_version: 1 }
  const rejected: Array<[string, Record<string, unknown>]> = [
    ['an already elapsed expiry', { expires_at: Date.now() - 1, max_runs: 2, failure_threshold: 1 }],
    ['an expiry beyond the seven day ceiling', { expires_at: Date.now() + 7 * 86400000 + 60_000, max_runs: 2, failure_threshold: 1 }],
    ['a zero run budget', { expires_at: Date.now() + 60_000, max_runs: 0, failure_threshold: 1 }],
    ['a run budget above 100', { expires_at: Date.now() + 60_000, max_runs: 101, failure_threshold: 1 }],
    ['a zero failure threshold', { expires_at: Date.now() + 60_000, max_runs: 2, failure_threshold: 0 }],
    ['a failure threshold above the run budget', { expires_at: Date.now() + 60_000, max_runs: 2, failure_threshold: 3 }],
  ]
  for (const [label, window] of rejected) {
    const response = await f.execute('skill_watch', { ...base, ...window })
    expect(response.isError, `${label}: ${JSON.stringify(response)}`).toBe(true)
    expect(JSON.stringify(response), label).toMatch(/invalid watch/u)
  }
  // No rejected window created a durable watch.
  expect(result(await f.execute('skill_watches', {}))).toEqual([])
  // The inclusive boundaries (exactly seven days, 100 runs, threshold===runs)
  // pin that the gates use <= / > exactly, so an in-window watch still works.
  const admitted = result(await f.execute('skill_watch', { ...base, expires_at: Date.now() + 7 * 86400000, max_runs: 100, failure_threshold: 100 }))
  expect(admitted.state).toBe('watching')
  expect(admitted.maxRuns).toBe(100)
  expect(admitted.failureThreshold).toBe(100)
})

test('skill_capture fails closed on a model-supplied expiry outside the finite window', async () => {
  // ENGINEERING-LAYER FAIL-CLOSED CONTRACT TEST, NOT REAL EXTERNAL-AUTHORITY
  // EVIDENCE: expires_at is a model-written argument on the public skill_capture
  // tool, and service.capture() validates the finite window before the policy or
  // Goals active-goal bridge, so both bounds are reachable through the plain
  // tool path with no extra fixture.
  const f = await fixture()
  const base = { owner_route_id: 'owner-route', goal_id: 'source-goal', name: 'captured-write', description: 'Captured writer.', parent_version: 0 }
  const rejected: Array<[string, number]> = [
    ['an already elapsed expiry', Date.now() - 1],
    ['an expiry beyond the seven day ceiling', Date.now() + 7 * 86400000 + 60_000],
  ]
  for (const [label, expiresAt] of rejected) {
    const response = await f.execute('skill_capture', { ...base, expires_at: expiresAt })
    expect(response.isError, `${label}: ${JSON.stringify(response)}`).toBe(true)
    expect(JSON.stringify(response), label).toMatch(/invalid capture expiry/u)
  }
})

test('skill_run fails closed on a model-supplied invocation_id outside the store gate', async () => {
  // ENGINEERING-LAYER FAIL-CLOSED CONTRACT TEST, NOT REAL EXTERNAL-AUTHORITY
  // EVIDENCE: invocation_id is a required model-written string on the public
  // skill_run tool with no schema maxLength; the store #validateClaim text(…,256)
  // gate (non-empty, <=256 chars, no Cc controls) is the single fail-closed
  // boundary that keeps the durable idempotency key well-formed and reachable.
  const f = await fixture()
  result(await f.save())
  const base = { goal_id: 'new-goal', name: 'saved-write', version: 1, inputs_json: '{"message":"reused"}' }
  const rejected: Array<[string, string]> = [
    ['an empty invocation_id', ''],
    ['a 257-character invocation_id', 'i'.repeat(257)],
    ['an invocation_id carrying a control character', 'bad' + String.fromCharCode(0) + 'id'],
  ]
  for (const [label, invocationId] of rejected) {
    const response = await f.execute('skill_run', { ...base, invocation_id: invocationId })
    expect(response.isError, `${label}: ${JSON.stringify(response)}`).toBe(true)
    expect(JSON.stringify(response), label).toMatch(/invalid invocation/u)
  }
  expect(runRows(f.root)).toBe(0)
  // The 256-character boundary is admitted and durably claimed exactly once.
  const admitted = result(await f.execute('skill_run', { ...base, invocation_id: 'i'.repeat(256) }))
  expect(admitted.state).not.toBe('awaiting-native-round')
  expect(runRows(f.root)).toBe(1)
})

test('skill_failure_candidate fails closed on model-supplied failure-window integer and length bounds', async () => {
  // ENGINEERING-LAYER FAIL-CLOSED CONTRACT TEST, NOT REAL EXTERNAL-AUTHORITY
  // EVIDENCE: minimum_occurrences and failure_locators entries are model-written
  // tool arguments with no schema min/max/maxLength; service failureWindow() is
  // the single fail-closed gate (1..32 count no greater than the locator count,
  // 1..32 locators, each session_id/goal_id a 1..4096 char string), and it runs
  // before any Goals Host evidence read.
  const f = await fixture(); result(await f.save()); const state = installFailureHost(f)
  const listed = (locators: Array<{ session_id: string; goal_id: string }>, minimumOccurrences: number) =>
    failureCandidateArgs({ trigger_goal_id: undefined, trigger_session_id: undefined, failure_locators: locators, minimum_occurrences: minimumOccurrences })
  const many = Array.from({ length: 33 }, (_value, index) => ({ session_id: `session-${index}`, goal_id: `goal-${index}` }))
  const rejected: Array<[string, Record<string, unknown>]> = [
    ['a zero minimum occurrence', listed([{ session_id: 's', goal_id: 'g' }], 0)],
    ['a minimum occurrence above 32 with enough locators', listed(many, 33)],
    ['an empty locator list', listed([], 1)],
    ['a 4097-character session id', listed([{ session_id: 's'.repeat(4097), goal_id: 'g' }], 1)],
    ['a 4097-character goal id', listed([{ session_id: 's', goal_id: 'g'.repeat(4097) }], 1)],
    ['an empty-string session id', listed([{ session_id: '', goal_id: 'g' }], 1)],
  ]
  for (const [label, args] of rejected) {
    const response = await f.execute('skill_failure_candidate', args)
    expect(response.isError, `${label}: ${JSON.stringify(response)}`).toBe(true)
    expect(JSON.stringify(response), label).toMatch(/invalid bounded failure locator window/u)
  }
  expect(state.failureReadCount()).toBe(0)
  expect(result(await f.execute('skill_candidates', {}))).toEqual([])
})

test('skill_repair_arm fails closed on a model-supplied expiry outside the finite window', async () => {
  // ENGINEERING-LAYER FAIL-CLOSED CONTRACT TEST, NOT REAL EXTERNAL-AUTHORITY
  // EVIDENCE: expires_at is a required model-written integer on the public
  // skill_repair_arm tool with no schema bounds; armRepair validates the past
  // bound and the min(holdout execution expiry, now+7d) ceiling before the
  // Goals snapshot read, the parent lookup, or any durable continuation, so
  // every counterexample is reachable through the plain tool path. The default
  // repair holdout lives 60s (its execution lifetime binds), while the second
  // fixture mounts a 30-day holdout so the seven-day cap itself binds.
  const base = { goal_id: 'source-goal', profile_id: 'repair-profile', owner_route_id: 'owner-route', invocation_id: 'arm-expiry' }
  const cases: Array<[string, number, number]> = [
    ['an already elapsed expiry', Date.now() - 1, 60_000],
    ['an expiry beyond the holdout execution lifetime', Date.now() + 120_000, 60_000],
    ['an expiry beyond the seven day ceiling', Date.now() + 7 * 86400000 + 60_000, 30 * 86400000],
  ]
  for (const [label, expiresAt, holdoutTtlMs] of cases) {
    const f = await fixture(false, false, 'owner-session', 'owner-session', undefined, image, true, 1, holdoutTtlMs)
    await expect.poll(() => f.ctx.tools.get('skill_repair_arm')).toBeDefined()
    const response = await f.execute('skill_repair_arm', { ...base, expires_at: expiresAt })
    expect(response.isError, `${label}: ${JSON.stringify(response)}`).toBe(true)
    expect(JSON.stringify(response), label).toMatch(/finite current repair profile required/u)
    const status = result(await f.execute('skill_repair_status', {})) as { continuations: unknown[] }
    expect(status.continuations, label).toEqual([])
  }
})

test('skill_retire and skill_rollback fail closed on model-supplied name and version values outside the store gates', async () => {
  // ENGINEERING-LAYER FAIL-CLOSED CONTRACT TEST, NOT REAL EXTERNAL-AUTHORITY
  // EVIDENCE: name and expected_version are required model-written tool
  // arguments; the tool schemas carry no pattern or numeric bounds, and the
  // fixture Policy stub authorizes solely from the live Agent, never from
  // argument content, so every malformed value below reaches the store gates
  // (store.ts name()/version() helpers at 146-147, #retire at ~545,
  // #rollback at ~744). A non-integer version never reaches them: the tool
  // schema integer type rejects it first with INVALID_ARGS, which the second
  // block pins honestly as the earlier (outer) gate. Rejection must leave v1
  // discoverable and replayable.
  const f = await fixture(); result(await f.save())
  const retireCases: Array<[string, string, number]> = [
    ['an uppercase skill name', 'Saved_Write', 1],
    ['a zero expected version', 'saved-write', 0],
    ['an expected version above the integer ceiling', 'saved-write', 1_000_000_001],
  ]
  for (const [label, name, expectedVersion] of retireCases) {
    const response = await f.execute('skill_retire', { name, expected_version: expectedVersion })
    expect(response.isError, `${label}: ${JSON.stringify(response)}`).toBe(true)
    expect(JSON.stringify(response), label).toMatch(/invalid skill reference/u)
  }
  const rollbackCases: Array<[string, string, number, number]> = [
    ['an illegal skill name', 'saved write', 1, 0],
    ['a zero expected version', 'saved-write', 0, 0],
    ['a negative target version', 'saved-write', 1, -1],
    ['a target version above the integer ceiling', 'saved-write', 1, 1_000_000_001],
  ]
  for (const [label, name, expectedVersion, targetVersion] of rollbackCases) {
    const response = await f.execute('skill_rollback', { name, expected_version: expectedVersion, target_version: targetVersion })
    expect(response.isError, `${label}: ${JSON.stringify(response)}`).toBe(true)
    expect(JSON.stringify(response), label).toMatch(/invalid skill reference/u)
  }
  // The outer tool-schema gate on the integer type: fractional values are
  // rejected before the handler (and therefore before the store version()
  // range check), so the store fractional branch is unreachable via tools.
  for (const args of [
    { name: 'saved-write', expected_version: 1.5 },
    { name: 'saved-write', expected_version: 1, target_version: 0.5 },
  ]) {
    const tool = args.target_version === undefined ? 'skill_retire' : 'skill_rollback'
    const response = await f.execute(tool, args)
    expect(response.isError, JSON.stringify(response)).toBe(true)
    expect(JSON.stringify(response)).toMatch(/must be an integer/u)
  }
  // All rejections are pre-mutation: v1 is still the sole active definition and
  // replay still works, proving no partial retirement/rollback persisted.
  const definitions = result(await f.execute('skill_status', {})) as Array<{ name: string; version: number; retired?: boolean }>
  expect(definitions).toEqual([expect.objectContaining({ name: 'saved-write', version: 1 })])
  expect((await f.run(`post-gate-${Math.random()}`)).isError).toBe(false)
})

test('opaque reference arguments fail closed on model-supplied ids outside the store text(id,128) gates', async () => {
  // ENGINEERING-LAYER FAIL-CLOSED CONTRACT TEST, NOT REAL EXTERNAL-AUTHORITY
  // EVIDENCE: every *_id an inspect or lifecycle tool accepts is a model-
  // written string the tool schemas bound only as {type:'string'} (no
  // minLength/maxLength/pattern). Store text(id,128) (store.ts:148: non-
  // empty, <=128, no Cc controls) is the single shape gate, and the handlers
  // below evaluate it while reading their referenced row — before any state
  // mutation or, where present, before authorization — so each counterexample
  // is reachable through the plain tool path with an empty fixture. A
  // well-formed but unknown id instead yields the tool's ordinary empty
  // result, proving the gate is about id shape, not row existence.
  const f = await fixture()
  const nul = String.fromCharCode(0)
  const long = 'x'.repeat(129)
  // Empty strings are not a counterexample for every tool: skill_candidates,
  // skill_status and skill_comparison_status treat a falsy id as "no id given"
  // and return their list view, so only a non-empty but over-long or
  // control-character id reaches the store gate there. The tools that pass the
  // id straight through reject the empty string as well.
  const cases: Array<[string, RegExp, string[]]> = [
    ['skill_candidates', /invalid candidate reference/u, [long, `p${nul}`]],
    ['skill_status', /invalid run reference/u, [long, `r${nul}`]],
    ['skill_comparison_status', /invalid comparison reference/u, [long, `c${nul}`]],
    ['skill_deployment_status', /invalid deployment reference/u, ['', long, `d${nul}`]],
    ['skill_reject', /invalid candidate reference/u, ['', long, `c${nul}`]],
  ]
  const idArg: Record<string, string> = {
    skill_candidates: 'candidate_id',
    skill_status: 'run_id',
    skill_deployment_status: 'deployment_id',
    skill_comparison_status: 'comparison_id',
    skill_reject: 'candidate_id',
  }
  for (const [tool, message, bads] of cases) {
    for (const bad of bads) {
      const response = await f.execute(tool, { [idArg[tool]!]: bad })
      expect(response.isError, `${tool} ${JSON.stringify(bad)}: ${JSON.stringify(response)}`).toBe(true)
      expect(JSON.stringify(response), `${tool} ${JSON.stringify(bad)}`).toMatch(message)
    }
  }
  // activate reads candidate and run before any authorization or mutation.
  for (const bad of ['', long]) {
    const response = await f.execute('skill_activate', { candidate_id: bad, trial_run_id: bad })
    expect(response.isError, JSON.stringify(response)).toBe(true)
    expect(JSON.stringify(response)).toMatch(/invalid (candidate|run) reference/u)
  }
  // canary validates the candidate id before the configured holdout is even
  // looked up, so an unusable profile id and valid finite-window integers do
  // not mask the earlier candidate-reference gate.
  for (const bad of ['', long, `c${nul}`]) {
    const response = await f.execute('skill_canary', { candidate_id: bad, profile_id: 'whatever', invocation_id: 'canary-ref', owner_route_id: 'route', expires_at: Date.now() + 60_000, max_runs: 1, canary_runs: 1 })
    expect(response.isError, JSON.stringify(response)).toBe(true)
    expect(JSON.stringify(response)).toMatch(/invalid candidate reference/u)
  }
  // Well-formed unknown ids never trip the shape gate: the inspect tools that
  // model a missing row return null. (skill_status for an unknown run id is
  // different: inspect() yields undefined, which the Host rejects as
  // non-lossless output — a pre-existing output-contract behaviour outside
  // this shape gate, so it is not asserted here.)
  expect(JSON.stringify(await f.execute('skill_candidates', { candidate_id: 'missing' }))).toContain('null')
  expect(JSON.stringify(await f.execute('skill_deployment_status', { deployment_id: 'missing' }))).toContain('null')
  expect(JSON.stringify(await f.execute('skill_comparison_status', { comparison_id: 'missing' }))).toContain('null')
})

test('skill_candidate fails closed on model-written reason/trigger outside the bounded free-text gate', async () => {
  // ENGINEERING-LAYER FAIL-CLOSED CONTRACT TEST, NOT REAL EXTERNAL-AUTHORITY
  // EVIDENCE: the skill_candidate tool schema types `reason`/`trigger` only as
  // {type:'string', required:true} with no minLength/maxLength, and they do NOT
  // pass through createDefinition (which bounds only name/description). They
  // ride untouched into store.stageCandidate, where text(reason,1024) and
  // text(trigger,1024) (store.ts text(): non-empty, <=1024, no Cc controls) is
  // the single shape gate, evaluated in the same condition before BEGIN
  // IMMEDIATE, so every counterexample is reachable through the plain tool
  // path with a valid name/description and the ordinary fixture.
  const f = await fixture()
  const nul = String.fromCharCode(0)
  const valid = { goal_id: 'source-goal', name: 'saved-write', description: 'Candidate writer.', bindings_json: JSON.stringify([{ name: 'message', stepId: 'step-1', path: '/data' }]), parent_version: 0 }
  const badFields: Array<['reason' | 'trigger', string, string]> = [
    ['reason', '', 'empty reason'],
    ['reason', 'x'.repeat(1025), 'over-long reason'],
    ['reason', `why${nul}`, 'control-char reason'],
    ['trigger', '', 'empty trigger'],
    ['trigger', 'x'.repeat(1025), 'over-long trigger'],
    ['trigger', `manual${nul}`, 'control-char trigger'],
  ]
  for (const [field, bad, label] of badFields) {
    const response = await f.execute('skill_candidate', { ...valid, reason: field === 'reason' ? bad : 'Owner requested a trial.', trigger: field === 'trigger' ? bad : 'manual review' })
    expect(response.isError, `${label}: ${JSON.stringify(response)}`).toBe(true)
    expect(JSON.stringify(response), label).toMatch(/invalid candidate/u)
    // Rejection precedes the write transaction: nothing is staged.
    expect(result(await f.execute('skill_candidates', {})), label).toEqual([])
  }
  // The 1024-char boundary is accepted: the gate is about string shape/length,
  // not about rejecting long-but-bounded owner prose.
  const bounded = result(await f.execute('skill_candidate', { ...valid, reason: 'r'.repeat(1024), trigger: 't'.repeat(1024) })) as { state: string }
  expect(bounded.state).toBe('pending')
  expect(result(await f.execute('skill_candidates', {}))).toHaveLength(1)
})

test('skill_save/skill_candidate fail closed on a model-written name, description, or binding shape outside the definition gate', async () => {
  // ENGINEERING-LAYER FAIL-CLOSED CONTRACT TEST, NOT REAL EXTERNAL-AUTHORITY
  // EVIDENCE: `name`/`description` are typed only {type:'string'} on both
  // skill_save and skill_candidate, and `bindings_json` is a free-form string
  // parsed straight into createDefinition. createDefinition (definition.ts:482)
  // is the single reachable gate: name must match /^[a-z]([a-z0-9-]{0,62}[a-z0-9])?$/,
  // description must be text(description,512), at most 8 bindings are allowed,
  // and each binding name/stepId is shaped and must reference an existing step.
  // It runs in service.save/stage before #authorize and the store write. The
  // store's own definitionValid name() check is NOT separately reachable on
  // this path (createDefinition rejects first) — it stays defence-in-depth and
  // is not claimed here. A malformed name on EITHER tool therefore rejects with
  // "invalid definition"; a bad binding set rejects at its own clause.
  const f = await fixture()
  const nul = String.fromCharCode(0)
  const badNames: Array<[string, string]> = [
    ['UPPER', 'uppercase name'],
    ['1lead', 'leading digit'],
    ['has space', 'embedded space'],
    ['a'.repeat(65), '65-char name (max is 64)'],
    ['-lead', 'leading hyphen'],
  ]
  for (const [bad, label] of badNames) {
    for (const tool of ['skill_save', 'skill_candidate'] as const) {
      const args = tool === 'skill_save'
        ? { goal_id: 'source-goal', name: bad, description: 'Fine description.', bindings_json: '[]', expected_version: 0 }
        : { goal_id: 'source-goal', name: bad, description: 'Fine description.', bindings_json: '[]', parent_version: 0, reason: 'Owner requested a trial.', trigger: 'manual review' }
      const response = await f.execute(tool, args)
      expect(response.isError, `${tool} ${label}: ${JSON.stringify(response)}`).toBe(true)
      expect(JSON.stringify(response), `${tool} ${label}`).toMatch(/invalid definition/u)
    }
  }
  const badDescriptions: Array<[string, string]> = [
    ['y'.repeat(513), 'over-long description'],
    [`d${nul}`, 'control-char description'],
  ]
  for (const [bad, label] of badDescriptions) {
    const response = await f.execute('skill_save', { goal_id: 'source-goal', name: 'saved-write', description: bad, bindings_json: '[]', expected_version: 0 })
    expect(response.isError, `${label}: ${JSON.stringify(response)}`).toBe(true)
    expect(JSON.stringify(response), label).toMatch(/invalid definition/u)
  }
  // Binding-shape gates inside createDefinition: the default fixture admits one
  // source Goal with a single write step (step-1), so all three are reachable
  // through the plain skill_save path with an otherwise-valid definition.
  const bindingBase = { goal_id: 'source-goal', name: 'saved-write', description: 'Write the saved artifact with a typed message.', expected_version: 0 }
  const bindingRejects: Array<[string, string, RegExp]> = [
    ['nine bindings (max is 8)', JSON.stringify(Array.from({ length: 9 }, (_v, i) => ({ name: `m${i}`, stepId: 'step-1', path: `/data${i}` }))), /too many bindings/u],
    ['an uppercase binding name', JSON.stringify([{ name: 'Message', stepId: 'step-1', path: '/data' }]), /invalid binding/u],
    ['a binding to a missing step', JSON.stringify([{ name: 'message', stepId: 'step-nope', path: '/data' }]), /binding step is missing/u],
  ]
  for (const [label, bindingsJson, message] of bindingRejects) {
    const response = await f.execute('skill_save', { ...bindingBase, bindings_json: bindingsJson })
    expect(response.isError, `${label}: ${JSON.stringify(response)}`).toBe(true)
    expect(JSON.stringify(response), label).toMatch(message)
  }
  // No rejected call created a definition (save) or a candidate.
  expect(result(await f.execute('skill_status', {}))).toEqual([])
  expect(result(await f.execute('skill_candidates', {}))).toEqual([])
  // Boundary values are accepted: 64-char name and 512-char description pass.
  result(await f.execute('skill_save', { goal_id: 'source-goal', name: 'a'.repeat(64), description: 'z'.repeat(512), bindings_json: '[]', expected_version: 0 }))
  expect(result(await f.execute('skill_status', {}))).toMatchObject([{ name: 'a'.repeat(64) }])
})

test('skill_run fails closed on model-supplied skill references and invocation inputs outside the reachable gates', async () => {
  // ENGINEERING-LAYER FAIL-CLOSED CONTRACT TEST, NOT REAL EXTERNAL-AUTHORITY
  // EVIDENCE: name/version and inputs_json are model-written tool arguments;
  // the schema bounds version only as integer (no range) and inputs only as a
  // string. service.run (service.ts:1405) reads the referenced skill through
  // store.get(scope, name) WITHOUT passing version, so the store version()
  // range helper is NOT reachable on this path — a zero, over-ceiling, or
  // merely non-current version fails the live-equality guard at
  // service.ts:1406 ("active skill version required"), while an illegal name
  // trips the get() name() gate first ("invalid skill reference"). After that,
  // #run calls instantiate (service.ts:1412) BEFORE the Goals Host bridge
  // (1421), preconditions (1438), or any claim: an undeclared input
  // (definition.ts:533) or a value whose type is not the bound scalar type
  // (definition.ts:537) is rejected with no durable run.
  const f = await fixture()
  // An illegal name reaches the get() name() gate even with no saved skill.
  const badName = await f.execute('skill_run', { goal_id: 'new-goal', name: 'Bad Name', version: 1, inputs_json: '{}', invocation_id: 'ref-bad-name' })
  expect(badName.isError).toBe(true)
  expect(JSON.stringify(badName)).toMatch(/invalid skill reference/u)
  expect(runRows(f.root)).toBe(0)
  // The version() shape/range gate is NOT reachable here (get takes no
  // version): with no live matching version the equality guard at 1406 fails
  // closed for version 0, an over-ceiling version, or a merely-wrong one.
  for (const [label, skillVersion] of [['a zero version', 0], ['an over-ceiling version', 1_000_000_001], ['a non-current version', 7]] as Array<[string, number]>) {
    const response = await f.execute('skill_run', { goal_id: 'new-goal', name: 'saved-write', version: skillVersion, inputs_json: '{}', invocation_id: `ref-${Math.random()}` })
    expect(response.isError, `${label}: ${JSON.stringify(response)}`).toBe(true)
    expect(JSON.stringify(response), label).toMatch(/active skill version required/u)
    expect(runRows(f.root), label).toBe(0)
  }
  // The outer tool-schema gate on the integer type: a fractional version is
  // rejected before the handler, never reaching either store/service gate.
  const fractional = await f.execute('skill_run', { goal_id: 'new-goal', name: 'saved-write', version: 1.5, inputs_json: '{}', invocation_id: 'ref-fraction' })
  expect(fractional.isError).toBe(true)
  expect(JSON.stringify(fractional)).toMatch(/must be an integer/u)
  expect(runRows(f.root)).toBe(0)
  // With a saved v1 whose single declared input is the string `message`,
  // malformed inputs are rejected at instantiate, before Goals or dispatch.
  result(await f.save())
  for (const [label, inputsJson, message] of [
    ['an undeclared input', '{"surprise":1}', /unknown invocation input/u],
    ['a type-mismatched declared input', '{"message":7}', /invocation input type mismatch/u],
  ] as Array<[string, string, RegExp]>) {
    const response = await f.execute('skill_run', { goal_id: `goal-${label.replace(/\W/g, '-')}`, name: 'saved-write', version: 1, inputs_json: inputsJson, invocation_id: `run-${Math.random()}` })
    expect(response.isError, `${label}: ${JSON.stringify(response)}`).toBe(true)
    expect(JSON.stringify(response), label).toMatch(message)
  }
  expect(runRows(f.root)).toBe(0)
  // A declared, correctly typed string input still runs, pinning the gate to
  // input shape rather than the run path itself.
  expect((await f.run(`post-gate-${Math.random()}`)).isError).toBe(false)
})

// Engineering-layer coverage of the owner-authorized autonomous growth
// success deposit (stageOwnerVerifiedSuccessCandidate).  The verified-source
// producer behind goals.inspectOwnerVerifiedWorkflowSource is a test seam
// installed by installSuccessHost, NOT real supplier/owner evidence: real
// owner-root (succeeded, quiescent, non-subagent) attestation is exercised by
// assistant-goals' own suite and by the growth-driver integration tests.
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
function rawSkills(f: Awaited<ReturnType<typeof fixture>>): AssistantSkillsService {
  return (f.ctx.get('assistantSkills' as never) as unknown as { [CORDIS_ORIGINAL]: AssistantSkillsService })[CORDIS_ORIGINAL]
}
function growthAuthority(f: Awaited<ReturnType<typeof fixture>>, overrides: { expiresAt?: number; assertCurrent?: () => void } = {}) {
  return { id: 'growth-authority', scope: f.scope, ownerRouteId: 'owner-route', expiresAt: Date.now() + 60_000, assertCurrent: () => {}, ...overrides }
}
function growthExec(f: Awaited<ReturnType<typeof fixture>>, signal: AbortSignal = new AbortController().signal) {
  return { agent: f.owner, signal }
}
function successDepositInput(locators: readonly { sessionId: string; goalId: string }[], extra: Partial<StageSuccessCandidateInput> = {}): StageSuccessCandidateInput {
  return { ownerRouteId: 'owner-route', successLocators: locators, minimumOccurrences: locators.length, name: 'grown-write', description: 'Grown repeated writer.', ...extra }
}

test('growth success deposit stages exactly one pending candidate after three distinct owner-verified successes', async () => {
  const f = await fixture()
  const host = installSuccessHost(f)
  const service = rawSkills(f)
  const candidate = await service.stageOwnerVerifiedSuccessCandidate(growthExec(f), successDepositInput(host.locators), growthAuthority(f)) as any
  // Identity + provenance projection: growth trigger carries the distinct-set digest.
  expect(candidate.id).toMatch(/^skill-candidate-[a-f0-9]{64}$/u)
  expect(candidate.state).toBe('pending')
  expect(candidate.parentVersion).toBe(0)
  expect(candidate.reason).toBe('Host-verified autonomous growth deposit after 3 independently owner-verified repeated successes.')
  expect(candidate.trigger).toMatch(/^growth-success:3:[a-f0-9]{64}$/u)
  expect(candidate.definition.name).toBe('grown-write')
  expect(candidate.definition.steps).toHaveLength(1)
  expect(candidate.definition.steps[0]!.toolName).toBe('write')
  // Every locator was independently re-read with the full six-field Host input.
  expect(host.successReadCount()).toBe(3)
  expect(host.successInputs).toEqual(host.locators.map(locator => ({ ownerRouteId: 'owner-route', principalId: 'owner', workspace: f.root, preset: 'primary', sessionId: locator.sessionId, goalId: locator.goalId })))
  // A pending candidate is not a current skill and never reaches skill_runs.
  expect(service.inspectOwnerActiveSkills(f.scope)).toEqual([])
  const listed = service.inspectOwnerSkillCandidates(f.scope)
  expect(listed).toHaveLength(1)
  expect(listed[0]!.id).toBe(candidate.id)
  expect(listed[0]!.state).toBe('pending')
  expect(runRows(f.root)).toBe(0)
})

test('growth success deposit defaults minimumOccurrences to one for a single locator', async () => {
  const f = await fixture()
  const host = installSuccessHost(f, { locators: successLocatorSet(1) })
  const candidate = await rawSkills(f).stageOwnerVerifiedSuccessCandidate(growthExec(f), successDepositInput(host.locators), growthAuthority(f)) as any
  expect(candidate.state).toBe('pending')
  expect(candidate.trigger).toMatch(/^growth-success:1:/u)
})

test('growth success deposit is idempotent for the same verified input set', async () => {
  const f = await fixture()
  const host = installSuccessHost(f)
  const service = rawSkills(f)
  const first = await service.stageOwnerVerifiedSuccessCandidate(growthExec(f), successDepositInput(host.locators), growthAuthority(f)) as any
  const second = await service.stageOwnerVerifiedSuccessCandidate(growthExec(f), successDepositInput(host.locators), growthAuthority(f)) as any
  expect(second.id).toBe(first.id)
  expect(service.inspectOwnerSkillCandidates(f.scope)).toHaveLength(1)
  expect(host.successReadCount()).toBe(6)
})

test.each([
  ['an unattested model-suggested locator', { behavior: (context: { input: { sessionId: string } }) => context.input.sessionId === 'ghost' ? new Error('ghost source') : undefined }, () => [{ sessionId: 'sess-1', goalId: 'goal-1' }, { sessionId: 'ghost', goalId: 'ghost-goal' }]],
  ['a source read that rejects', { behavior: () => Object.assign(new Error('unknown outcome'), { code: 'unknown' }) }, () => successLocatorSet(3)],
  ['a forged source goal identity', { behavior: (context: { source: VerifiedWorkflowSource }) => ({ ...context.source, goal: { ...context.source.goal, id: `${context.source.goal.id}-forged` } }) }, () => successLocatorSet(3)],
  ['a sibling-owner source scope', { behavior: (context: { source: VerifiedWorkflowSource }) => ({ ...context.source, scope: { ...context.source.scope, principalRecordId: 'foreign-record' } }) }, () => successLocatorSet(3)],
  ['a route rebound mid re-read', { behavior: undefined as never, rebindOnRead: 2 }, () => successLocatorSet(3)],
] as const)('growth success deposit fails closed on %s without writing', async (_label, behaviorOptions, locatorFactory) => {
  const f = await fixture()
  const locators = locatorFactory()
  const host = installSuccessHost(f, { locators, behavior: (context: { input: { sessionId: string }; read: number; source: VerifiedWorkflowSource }) => {
    if ((behaviorOptions as { rebindOnRead?: number }).rebindOnRead === context.read) f.rebindRoute()
    return (behaviorOptions as { behavior?: (context: { input: { sessionId: string }; read: number; source: VerifiedWorkflowSource }) => VerifiedWorkflowSource | Error | void }).behavior?.(context)
  } })
  await expect(rawSkills(f).stageOwnerVerifiedSuccessCandidate(growthExec(f), successDepositInput(locators), growthAuthority(f))).rejects.toThrow()
  expect(rawSkills(f).inspectOwnerSkillCandidates(f.scope)).toEqual([])
  expect(runRows(f.root)).toBe(0)
  expect(host.successReadCount()).toBeGreaterThan(0)
})

test('growth success deposit rejects a window asking for more occurrences than locators', async () => {
  const f = await fixture()
  const host = installSuccessHost(f)
  await expect(rawSkills(f).stageOwnerVerifiedSuccessCandidate(growthExec(f),
    successDepositInput(host.locators, { minimumOccurrences: 4 }), growthAuthority(f))).rejects.toThrow('invalid bounded success locator window')
  expect(rawSkills(f).inspectOwnerSkillCandidates(f.scope)).toEqual([])
})

test.each([
  ['an expired authority', (f: Awaited<ReturnType<typeof fixture>>) => growthAuthority(f, { expiresAt: Date.now() - 1 }), (input: StageSuccessCandidateInput) => input, 'growth success authority unavailable'],
  ['a stale authority lease', (f: Awaited<ReturnType<typeof fixture>>) => growthAuthority(f, { assertCurrent: () => { throw new Error('owner route changed during growth wake') } }), (input: StageSuccessCandidateInput) => input, 'owner route changed during growth wake'],
  ['an input bound to another route', (f: Awaited<ReturnType<typeof fixture>>) => growthAuthority(f), (input: StageSuccessCandidateInput) => ({ ...input, ownerRouteId: 'other-route' }), 'growth success input does not match authority'],
] as const)('growth success deposit rejects %s without writing', async (_label, authorityFactory, inputMutate, message) => {
  const f = await fixture()
  const host = installSuccessHost(f)
  const service = rawSkills(f)
  await expect(service.stageOwnerVerifiedSuccessCandidate(growthExec(f), inputMutate(successDepositInput(host.locators)), authorityFactory(f))).rejects.toThrow(message)
  expect(service.inspectOwnerSkillCandidates(f.scope)).toEqual([])
  expect(runRows(f.root)).toBe(0)
})

test('growth success deposit fails closed on an already-aborted exec signal', async () => {
  const f = await fixture()
  const host = installSuccessHost(f)
  const controller = new AbortController(); controller.abort()
  await expect(rawSkills(f).stageOwnerVerifiedSuccessCandidate(growthExec(f, controller.signal), successDepositInput(host.locators), growthAuthority(f))).rejects.toThrow()
  expect(rawSkills(f).inspectOwnerSkillCandidates(f.scope)).toEqual([])
  expect(host.successReadCount()).toBe(0)
})

test('growth success deposit stages against a live current parent version', async () => {
  const f = await fixture(); result(await f.save())
  const host = installSuccessHost(f)
  const candidate = await rawSkills(f).stageOwnerVerifiedSuccessCandidate(growthExec(f),
    successDepositInput(host.locators, { name: 'saved-write', description: 'Grown parented writer.' }), growthAuthority(f)) as any
  expect(candidate.state).toBe('pending')
  expect(candidate.parentVersion).toBe(1)
  const active = rawSkills(f).inspectOwnerActiveSkills(f.scope)
  expect(active).toHaveLength(1)
  expect(active[0]!.name).toBe('saved-write')
  expect(active[0]!.version).toBe(1)
  expect(rawSkills(f).inspectOwnerSkillCandidates(f.scope)).toHaveLength(1)
})

test('growth success deposit refuses to resurrect a retired same-name skill', async () => {
  const f = await fixture(); result(await f.save())
  result(await f.execute('skill_retire', { name: 'saved-write', expected_version: 1 }))
  const host = installSuccessHost(f)
  await expect(rawSkills(f).stageOwnerVerifiedSuccessCandidate(growthExec(f),
    successDepositInput(host.locators, { name: 'saved-write', description: 'Would-be resurrection.' }), growthAuthority(f))).rejects.toThrow('version conflict')
  expect(rawSkills(f).inspectOwnerSkillCandidates(f.scope)).toEqual([])
})

test('owner skill enumeration distinguishes active skills from pending candidates', async () => {
  const f = await fixture(); result(await f.save())
  const service = rawSkills(f)
  expect(service.inspectOwnerActiveSkills(f.scope)).toHaveLength(1)
  expect(service.inspectOwnerSkillCandidates(f.scope)).toEqual([])
  const host = installSuccessHost(f)
  await service.stageOwnerVerifiedSuccessCandidate(growthExec(f), successDepositInput(host.locators), growthAuthority(f))
  expect(service.inspectOwnerActiveSkills(f.scope)).toHaveLength(1)
  expect(service.inspectOwnerSkillCandidates(f.scope)).toHaveLength(1)
})

test('owner skill enumeration throws once the service has been disposed', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'assistant-skills-inactive-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  const service = new AssistantSkillsService(ctx, { databasePath: join(root, 'skills.sqlite'), allowedTools: ['write'] })
  await ctx.fiber.dispose()
  const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: root, preset: 'primary' }
  expect(() => service.inspectOwnerActiveSkills(scope)).toThrow('assistant-skills: inactive')
  expect(() => service.inspectOwnerSkillCandidates(scope)).toThrow('assistant-skills: inactive')
})
