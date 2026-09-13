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
import { inspect } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { acceptanceDigest, createTaskAcceptanceContract, createTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import { canonicalEvaluationHostScope, canonicalEvaluationScope, evaluationLearningProjectionDigest } from '@dsh-enhanced/assistant-evaluation'
import { failureSummaryEvidenceDigest, type HostFailureEvidenceSummary } from '../src/definition.ts'
import { AssistantSkillsService } from '../src/service.ts'
import { generatorDigest, prospectiveGeneratorDigest } from '../src/prospective-holdout.ts'

const cleanups: (() => Promise<void>)[] = []
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const cli = fileURLToPath(new URL('../lib/holdout-cli.js', import.meta.url))
const candidateImage = process.env.DSH_HOLDOUT_TEST_IMAGE ?? ''
const topologyGeneratorDigest = prospectiveGeneratorDigest('dependency-topological-order/v1')
const topologyImplementation = String.raw`let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const label = /^[a-z][a-z0-9]{1,31}$/
  const nodes = new Set(), edges = new Set()
  for (const line of input.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 2 || !label.test(fields[0]) || !label.test(fields[1])) continue
    nodes.add(fields[0]); nodes.add(fields[1]); edges.add(fields[0] + '\0' + fields[1])
  }
  const indegree = new Map([...nodes].map(node => [node, 0]))
  const outgoing = new Map([...nodes].map(node => [node, []]))
  for (const edge of edges) {
    const [before, after] = edge.split('\0')
    outgoing.get(before).push(after); indegree.set(after, indegree.get(after) + 1)
  }
  const ready = [...nodes].filter(node => indegree.get(node) === 0).sort(), order = []
  while (ready.length > 0) {
    const node = ready.shift(); order.push(node)
    for (const after of outgoing.get(node).sort()) {
      const remaining = indegree.get(after) - 1; indegree.set(after, remaining)
      if (remaining === 0) ready.push(after)
    }
    ready.sort()
  }
  process.stdout.write(order.length === nodes.size ? order.join('\n') + '\n' : 'CYCLE\n')
})`
const wrongTopologyImplementation = "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('WRONG\\n'))"
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function agent(ctx: Context, workspace: string): Agent {
  const id = SessionId('external-owner'), session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: workspace, agentPreset: 'primary' })
  const value: Agent = { id, options: { provider: 'fixture', model: 'fixture' }, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }), ctx: undefined as unknown as Context, status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ;(value as unknown as { ctx: Context }).ctx = createScope(ctx, value).ctx; session.append('turn/start', { turn: 1 }); return value
}

test('skill_qualify uses one external process attempt, persists unknown, and exposes only scoped execution metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-holdout-service-')), stateRoot = await mkdtemp(join(tmpdir(), 'external-holdout-state-')), cancelledStateRoot = await mkdtemp(join(tmpdir(), 'external-holdout-cancel-state-')), comparisonStateRoot = await mkdtemp(join(tmpdir(), 'local-comparison-state-')), prospectiveStateRoot = await mkdtemp(join(tmpdir(), 'prospective-holdout-state-')), foreignStateRoot = await mkdtemp(join(tmpdir(), 'foreign-holdout-state-'))
  await chmod(stateRoot, 0o700); await chmod(cancelledStateRoot, 0o700); await chmod(comparisonStateRoot, 0o700); await chmod(prospectiveStateRoot, 0o700); await chmod(foreignStateRoot, 0o700); cleanups.push(() => rm(root, { recursive: true, force: true }), () => rm(stateRoot, { recursive: true, force: true }), () => rm(cancelledStateRoot, { recursive: true, force: true }), () => rm(comparisonStateRoot, { recursive: true, force: true }), () => rm(prospectiveStateRoot, { recursive: true, force: true }), () => rm(foreignStateRoot, { recursive: true, force: true }))
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
  const plugin = await ctx.plugin(AssistantSkillsService, { databasePath: join(root, 'skills.sqlite'), allowedTools: ['write'], comparisons: [{ id: 'external', version: 1, scope, stateRoot: comparisonStateRoot, image: execution.image, dockerPath: execution.dockerPath, command: execution.command, artifactPath: execution.artifactPath, expiresAt: execution.expiresAt, maxComparisons: 1, repeats: 2, maxToolCalls: 2, maxBytes: 4096, maxOutputBytes: 1024, cellDurationMs: 1000, verificationDurationMs: 1, minimumEvaluationGain: 0.1, cases: [{ id: 'replay', kind: 'replay', inputs: {}, files: [], stdin: '', expectedStdout: '', expectedExitCode: 0 }, { id: 'evaluation', kind: 'evaluation', inputs: {}, files: [], stdin: '', expectedStdout: '', expectedExitCode: 0 }, { id: 'regression', kind: 'regression', inputs: {}, files: [], stdin: '', expectedStdout: '', expectedExitCode: 0 }] }], externalHoldouts: [{ id: 'external', version: 1, scope, execution: { ...execution, stateRoot }, authority: { executable: process.execPath, args: [script, marker], publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), datasetDigest: digest('dataset') }, maxComparisons: 1 }, { id: 'cancelled', version: 1, scope, execution: { ...execution, stateRoot: cancelledStateRoot }, authority: { executable: process.execPath, args: [script, marker, 'hold'], publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), datasetDigest: digest('dataset') }, maxComparisons: 1 }, { id: 'prospective', version: 1, scope, execution: { ...execution, stateRoot: prospectiveStateRoot }, authority: { executable: process.execPath, args: [script, marker, 'prospective'], publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest }, maxComparisons: 1 }, { id: 'foreign', version: 1, scope: { ...scope, principalId: 'foreign', principalRecordId: 'foreign-record' }, execution: { ...execution, stateRoot: foreignStateRoot }, authority: { executable: process.execPath, args: [script, marker, 'foreign'], publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), datasetDigest: digest('foreign-dataset') }, maxComparisons: 1 }] })
  cleanups.push(() => plugin.dispose())
  const execute = (name: string, toolArguments: object, signal = new AbortController().signal) => owner.ctx.get('tools')!.execute({ callId: ToolCallId(`call-${Math.random()}`), name, arguments: toolArguments, signal, agent: owner })
  const json = async (name: string, toolArguments: object) => {
    const result = await execute(name, toolArguments)
    expect(result.isError, inspect(result)).toBe(false)
    return JSON.parse((result.value as { context: string }).context)
  }
  const profileIdDescription = (name: string) => {
    const parameters = ctx.tools.get(name)!.parameters as Record<string, unknown>
    const properties = parameters.properties as Record<string, unknown> | undefined
    const profileId = parameters.profile_id ?? properties?.profile_id
    if (!profileId || typeof profileId !== 'object') throw new Error(`missing profile_id schema for ${name}`)
    return (profileId as { description?: string }).description
  }
  expect(ctx.tools.get('skill_comparison_status')!.description).toContain('call without comparison_id to discover exact owner-scoped configured profile IDs')
  expect(profileIdDescription('skill_compare')).toContain('executionTool=skill_compare')
  expect(profileIdDescription('skill_qualify')).toContain('executionTool=skill_qualify')
  expect(profileIdDescription('skill_canary')).toContain('never infer it from generator, task, or version labels')
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
  expect(status).toEqual(expect.arrayContaining([
    { id: 'external', version: 1, kind: 'local', executionTool: 'skill_compare', expiresAt: expect.any(Number), cases: 3, repeats: 2, maxComparisons: 1 },
    { id: 'external', version: 1, kind: 'external', executionTool: 'skill_qualify', expiresAt: expect.any(Number), maxComparisons: 1 },
    { id: 'prospective', version: 1, kind: 'external', executionTool: 'skill_qualify', expiresAt: expect.any(Number), maxComparisons: 1 },
  ]))
  expect(status.find((entry: { id: string }) => entry.id === 'prospective')).not.toHaveProperty('canaryExecutionTool')
  expect(status).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'foreign' })]))
  expect(JSON.stringify(status)).not.toMatch(/publicKey|datasetDigest|generatorDigest|authority\.mjs|stateRoot/u)
})

test.skipIf(!/^sha256:[a-f0-9]{64}$/u.test(candidateImage))('qualification leaves the source workspace and pending candidate unchanged before a later topology canary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-holdout-positive-')), stateRoot = await mkdtemp(join(tmpdir(), 'external-holdout-positive-state-')), qualificationStateRoot = await mkdtemp(join(tmpdir(), 'external-holdout-qualification-state-')), authorityRoot = await mkdtemp(join(tmpdir(), 'external-holdout-authority-'))
  await chmod(stateRoot, 0o700); await chmod(qualificationStateRoot, 0o700); await chmod(authorityRoot, 0o700); cleanups.push(() => rm(root, { recursive: true, force: true }), () => rm(stateRoot, { recursive: true, force: true }), () => rm(qualificationStateRoot, { recursive: true, force: true }), () => rm(authorityRoot, { recursive: true, force: true }))
  const keyPair = generateKeyPairSync('ed25519')
  const key = join(authorityRoot, 'key.pem'), authorityConfig = join(authorityRoot, 'authority.json'), qualificationAuthorityConfig = join(authorityRoot, 'qualification-authority.json'), marker = join(authorityRoot, 'starts'), hook = join(authorityRoot, 'mark-start.mjs')
  await writeFile(key, keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  await writeFile(authorityConfig, JSON.stringify({ prospective: { generator: 'dependency-topological-order/v1' }, privateKeyPath: key, statePath: join(authorityRoot, 'authority.sqlite'), limits: { maxToolCalls: 2, maxOutputBytes: 1024 } }), { mode: 0o600 })
  await writeFile(qualificationAuthorityConfig, JSON.stringify({ prospective: { generator: 'dependency-topological-order/v1' }, privateKeyPath: key, statePath: join(authorityRoot, 'qualification-authority.sqlite'), limits: { maxToolCalls: 2, maxOutputBytes: 1024 } }), { mode: 0o600 })
  await writeFile(hook, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'x')`, { mode: 0o600 })
  const ctx = new Context(), owner = agent(ctx, root), scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, preset: 'primary' }
  cleanups.push(() => ctx.fiber.restart()); ctx.provide('agents' as never, { get: () => owner, list: () => [owner] } as never)
  const route = { authorityId: 'owner-route', principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } }), currentPreferenceTurn: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } }), validateOwnerRoute: (input: typeof route) => input.authorityId === route.authorityId && input.principalId === route.principalId && input.workspace === route.workspace && input.agentPreset === route.agentPreset ? route : undefined } as never)
  let policyAllowed = true
  ctx.provide('assistantPolicy' as never, { evaluateAgent: () => ({ effect: policyAllowed ? 'allow' : 'deny' }), authorizeAgent: () => ({ effect: policyAllowed ? 'allow' : 'deny' }), evaluate: () => ({ effect: policyAllowed ? 'allow' : 'deny' }), authorize: () => ({ effect: policyAllowed ? 'allow' : 'deny' }) } as never)
  const objective = 'Produce the deterministic dependency topological order', goalDefinitionDigest = acceptanceDigest({ objective })
  const outcomeProfile = { id: 'topology-outcome', version: 1, digest: digest('topology-outcome') }, evidenceNow = Date.now()
  const source = { protocol: 'assistant-goals/verified-workflow-source/v1' as const, scope, goal: { id: 'repair-goal', definition: { version: 1, digest: goalDefinitionDigest, objective }, sessionId: 'repair-session', nativeGoalId: 'repair-native' }, runId: 'repair-run', turn: 1, acceptance: { contractId: 'repair-contract', contractDigest: digest('repair-contract'), receiptDigest: digest('repair-receipt'), verifiedAt: evidenceNow - 1000, validUntil: evidenceNow + 120000 }, steps: [{ id: 'write-topology', toolName: 'write', arguments: { file_path: 'topology.mjs', content: wrongTopologyImplementation } }], failedObservations: [] }
  const snapshots = new Map<string, unknown>()
  const canonicalOutcomes = new Map<string, any>()
  const canonicalListeners = new Set<(notice: unknown) => void>()
  let canonicalWatermark = 0
  const currentCanonical = (assessmentId: string) => {
    const value = canonicalOutcomes.get(assessmentId)
    return value && { ...structuredClone(value), scopeWatermark: canonicalWatermark }
  }
  const failureSummaryReads: unknown[] = []
  const failureLocators = [{ sessionId: 'failure-session-b', goalId: 'failure-goal-b' }, { sessionId: 'failure-session-a', goalId: 'failure-goal-a' }]
  const failures = [...failureLocators].reverse().map((locator, index) => ({ goal: { id: locator.goalId, definition: source.goal.definition, sessionId: locator.sessionId, nativeGoalId: `failure-native-${index + 1}` }, runId: `failure-run-${index + 1}`, execution: { status: 'succeeded' as const, quiescent: true as const }, outcome: 'not-achieved' as const,
    acceptance: { contractId: `failure-contract-${index + 1}`, contractDigest: digest(`failure-contract-${index + 1}`), receiptDigest: digest(`failure-receipt-${index + 1}`), verifiedAt: evidenceNow - 3000 + index * 500, validUntil: evidenceNow + 120000 }, traceDigest: digest(`failure-trace-${index + 1}`) }))
  const unsignedFailureSummary = { protocol: 'assistant-skills/host-failure-evidence/v1' as const, scope, taskFamily: { id: 'dependency-topological-order', definitionDigest: goalDefinitionDigest, objective }, failureCategory: 'repeated-not-achieved' as const,
    triggerCondition: { kind: 'not-achieved-count' as const, minimumOccurrences: 2, windowStartedAt: failures[0]!.acceptance.verifiedAt, windowEndedAt: failures[1]!.acceptance.verifiedAt }, failures, repairGoal: source.goal, attestedAt: evidenceNow }
  const goalsGeneration = 'external-topology-fixture-v1'
  const failureSummary: HostFailureEvidenceSummary = { ...unsignedFailureSummary, evidence: { producer: 'assistant-goals', generation: goalsGeneration, digest: failureSummaryEvidenceDigest(unsignedFailureSummary, goalsGeneration) } }
  ctx.provide('assistantVerifier' as never, {} as never)
  ctx.provide('assistantGoals' as never, { inspectVerifiedWorkflowSource: () => source,
    // Goals' package tests derive and validate repeated failure evidence from real
    // Host snapshots. This fixture reuses that Host-only capability boundary so
    // this package can exercise the complete Skills consumer lifecycle.
    trustedAcceptanceProducerGeneration: () => goalsGeneration,
    inspectOwnerFailureCaptureSummary: async (input: unknown) => { failureSummaryReads.push(structuredClone(input)); return structuredClone(failureSummary) },
    inspectOwnerVerifiedWorkflowSource: async () => structuredClone(source),
    inspectWorkflowRunContext: (_agent: Agent, goalId: string) => ({ scope, goalId, sessionId: String(owner.session.id), goalExecutionRunId: `execution-${goalId}`, nativeGoalId: `native-${goalId}`, definition: { version: 1, digest: goalDefinitionDigest } }),
    inspectOwnerGoalExecution: (input: { goalId: string }) => snapshots.get(input.goalId) ?? {},
    inspectOwnerGoalRunProof: async (input: { goalId: string; runId: string }) => {
      const invocationId = input.goalId === 'canary-goal' ? 'first-use' : input.goalId === 'later-goal' ? 'second-use' : undefined
      if (!invocationId) throw new Error('fixture run is unavailable')
      const inputsJson = input.goalId === 'later-goal' ? JSON.stringify({ implementation: wrongTopologyImplementation }) : '{}'
      const payload = { protocol: 'assistant-goals/owner-run-trace/v1' as const, runId: input.runId, turn: 1, nativeRevision: 1, definitionDigest: goalDefinitionDigest,
        outcomeProfile, steps: [{ id: `call-${input.runId}`, name: 'skill_run', arguments: { goal_id: input.goalId, name: 'topology-order', version: 2, inputs_json: inputsJson, invocation_id: invocationId }, outcome: 'succeeded' as const }] }
      return { ...payload, traceDigest: acceptanceDigest(payload) }
    } } as never)
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
      const value = currentCanonical(input.assessmentId)
      return value && value.scope !== undefined && (value.scope as { workspace: string; preset: string }).workspace === input.scope.workspace
        && (value.scope as { workspace: string; preset: string }).preset === input.scope.preset ? value : undefined
    },
    withTrustedCanonicalTaskWriterFence: (input: { scope: { workspace: string; preset: string }; scopeWatermark: number; evidence: readonly { subjectKind: string; subjectRef: string; version: number; digest: string; disposition: 'upsert' | 'retract' }[] }, callback: () => unknown) => {
      const matched = canonicalWatermark === input.scopeWatermark && input.evidence.every(expected => {
        const current = currentCanonical(expected.subjectRef) as { scope?: { workspace: string; preset: string }; projection?: { subjectKind: string; subjectRef: string; version: number; digest: string; disposition: string } } | undefined
        return current?.scope?.workspace === input.scope.workspace && current.scope.preset === input.scope.preset
          && expected.subjectKind === current.projection?.subjectKind && expected.subjectRef === current.projection.subjectRef
          && expected.version === current.projection.version && expected.digest === current.projection.digest && expected.disposition === current.projection.disposition
      })
      return matched ? { matched: true, value: callback() } : { matched: false, reason: 'evidence-changed' }
    },
    onTrustedTaskChange: (listener: (notice: unknown) => void) => { canonicalListeners.add(listener); return () => canonicalListeners.delete(listener) },
  } as never)
  // Explicit independent-acceptance fixtures exercise the production watch consumer.
  // CLI qualification above/below executes real programs; these Goal outcomes do not claim a real verifier run.
  const acceptRun = (run: { goalId: string; goalExecutionRunId: string }, achieved: boolean) => {
    const now = Date.now(), goal = { id: run.goalId, definitionVersion: 1, definitionDigest: goalDefinitionDigest, sessionId: String(owner.session.id), nativeGoalId: `native-${run.goalId}` }
    const contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v3', id: `outcome-${run.goalId}`, task: { kind: 'goal-outcome', ref: `assessment-${run.goalId}`, goal: { ...goal, assessmentId: `assessment-${run.goalId}` } },
      scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: 'record', principalVersion: 1 }, objective: 'Fixture: verify the reused topology result', profile: outcomeProfile,
      criteria: [{ id: 'result', kind: 'target-readback', authority: { id: 'fixture', digest: digest('fixture') }, objectId: 'output', expected: [{ pointer: '/ready', value: true }] }], issuedAt: now - 1000, expiresAt: now + 60000, bounds: { maxDurationMs: 1000, maxEvidenceBytes: 4096 } })
    const receipt = createTaskVerificationReceipt(contract, { protocol: 'task-verification/v3', id: `receipt-${run.goalId}`, contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner, task: contract.task,
      results: [{ criterionId: 'result', status: achieved ? 'passed' : 'failed', reason: 'explicit-engineering-fixture', evidence: [] }], startedAt: now, completedAt: now, validUntil: now + 60000 })
    const execution = { status: 'succeeded', quiescent: true, completedAt: now }
    snapshots.set(run.goalId, { storedGoal: { id: run.goalId, scope, definition: { version: 1, digest: goal.definitionDigest }, nativeAtLastObservation: { sessionId: goal.sessionId, goalId: goal.nativeGoalId } },
      executionRuns: [{ intent: { runId: run.goalExecutionRunId, scope, task: { kind: 'goal-step', goal: { ...goal, nativeRevision: 1 } } }, dispatchedAt: now - 1000, execution }],
      outcomeAssessments: [{ triggerRunId: run.goalExecutionRunId, contract, dispatchedAt: now - 1000, execution }],
      acceptedTasks: [{ contractId: contract.id, state: 'done', contract, receipt, verifierExecutionObservation: { ...execution, executionRef: contract.task.ref } }] })
    const evaluationScope = { workspace: root, preset: 'primary' }, scopeKey = canonicalEvaluationScope(evaluationScope).scopeKey, assessmentId = contract.task.ref
    const evaluationExecution = { outcomeId: `evaluation-execution-${run.goalId}`, status: 'succeeded' as const, source: { kind: 'evaluator' as const, id: 'assistant-verifier' }, evidence: [{ kind: 'goal-outcome' as const, ref: assessmentId }], occurredAt: now, evaluator: { id: 'assistant-verifier', version: '1' } }
    const evaluationObjective = { outcomeId: `evaluation-objective-${run.goalId}`, status: achieved ? 'achieved' as const : 'not-achieved' as const, source: { kind: 'evaluator' as const, id: 'assistant-verifier' }, evidence: [{ kind: 'goal-outcome' as const, ref: assessmentId }], occurredAt: now, evaluator: { id: 'assistant-verifier', version: '1' } }
    const projectionBase = { subjectKind: 'goal-outcome' as const, subjectRef: assessmentId, disposition: 'upsert' as const, evidenceOutcomeId: evaluationObjective.outcomeId }
    const projection = { ...projectionBase, version: 1, digest: evaluationLearningProjectionDigest({ scopeKey, situation: `goal:${run.goalId}:definition:1`, execution: evaluationExecution, objective: evaluationObjective, projection: projectionBase }) }
    canonicalWatermark++
    canonicalOutcomes.set(assessmentId, { triggerOutcomeId: evaluationObjective.outcomeId, scope: evaluationScope, scopeKey, scopeWatermark: canonicalWatermark, situation: `goal:${run.goalId}:definition:1`, execution: evaluationExecution, objective: evaluationObjective, projection })
    for (const listener of canonicalListeners) listener({ subjectKind: 'goal-outcome', subjectRef: assessmentId })
    ctx.emit('assistant-verifier/receipt', { taskKind: 'goal-outcome' } as never)
  }

  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(SkillRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root }); await ctx.plugin(FsPolicy); await ctx.plugin(FileTools)
  const baseConfig = { databasePath: join(root, 'skills.sqlite'), allowedTools: ['read', 'write'] }
  let plugin = await ctx.plugin(AssistantSkillsService, baseConfig); cleanups.push(() => plugin.dispose())
  const execute = (name: string, toolArguments: object) => owner.ctx.get('tools')!.execute({ callId: ToolCallId(`call-${Math.random()}`), name, arguments: toolArguments, signal: new AbortController().signal, agent: owner })
  const json = async (name: string, toolArguments: object) => {
    const result = await execute(name, toolArguments)
    expect(result.isError, inspect(result)).toBe(false)
    return JSON.parse((result.value as { context: string }).context)
  }
  const parent = await json('skill_save', { goal_id: 'repair-goal', name: 'topology-order', description: 'baseline topology implementation', bindings_json: '[]', expected_version: 0 })
  source.steps[0]!.arguments = { file_path: 'topology.mjs', content: topologyImplementation }
  const candidate = await json('skill_failure_candidate', { owner_route_id: route.authorityId, failure_locators: failureLocators.map(locator => ({ session_id: locator.sessionId, goal_id: locator.goalId })), minimum_occurrences: 2, repair_goal_id: source.goal.id, repair_session_id: source.goal.sessionId, task_family_id: 'dependency-topological-order', name: 'topology-order', description: 'deterministic topological ordering', bindings_json: JSON.stringify([{ name: 'implementation', stepId: 'write-topology', path: '/content' }]), parent_version: 1 })
  expect(failureSummaryReads).toEqual([{ ownerRouteId: route.authorityId, principalId: 'owner', workspace: root, preset: 'primary', taskFamilyId: 'dependency-topological-order', repair: { sessionId: 'repair-session', goalId: 'repair-goal' }, failures: [
    { sessionId: 'failure-session-a', goalId: 'failure-goal-a' }, { sessionId: 'failure-session-b', goalId: 'failure-goal-b' },
  ], minimumOccurrences: 2 }])
  expect(candidate).toMatchObject({ state: 'pending', trigger: 'host-verified-failure:repeated-not-achieved', failure: { category: 'repeated-not-achieved', count: 2, digest: expect.stringMatching(/^[a-f0-9]{64}$/u) }, definition: { name: 'topology-order', source: { goalDefinitionDigest }, inputs: [{ name: 'implementation', stepId: 'write-topology', path: '/content', type: 'string', default: topologyImplementation }], steps: [{ id: 'write-topology', toolName: 'write', arguments: { file_path: 'topology.mjs', content: topologyImplementation } }] } })
  expect(candidate.failure).toMatchObject({ protocol: 'assistant-skills/failure-capture-provenance/v1',
    provenanceDigest: candidate.failure.digest, category: 'repeated-not-achieved', occurrences: 2, count: 2,
    taskFamilyId: 'dependency-topological-order', taskFamilyDefinitionDigest: goalDefinitionDigest,
    rollbackTarget: { name: 'topology-order', version: 1 } })
  expect(JSON.stringify(candidate)).not.toMatch(/failure-(?:session|goal|native|run)|repair-(?:session|native|run)|contractId|receiptDigest|traceDigest|failureProvenance/u)
  const config = { ...baseConfig, externalHoldouts: [{ id: 'positive', version: 1, scope, execution: { image: candidateImage, dockerPath: '/usr/bin/docker', stateRoot, command: '/usr/local/bin/node /workspace/artifact < /workspace/input', artifactPath: 'topology.mjs', expiresAt: Date.now() + 120000, repeats: 2, maxToolCalls: 2, maxBytes: 4096, maxOutputBytes: 1024, cellDurationMs: 20000, verificationDurationMs: 10000 }, authority: { executable: process.execPath, args: ['--import', hook, cli, '--config', authorityConfig], publicKey: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest: topologyGeneratorDigest },
    canaryAdmission: { protocol: 'assistant-skills/canary-admission/v1' as const, skillName: 'topology-order', parentDefinitionDigest: acceptanceDigest(parent), candidateDefinitionDigest: candidate.definitionDigest,
      taskFamily: { goalDefinitionDigest, outcomeProfile } }, maxComparisons: 1 as const },
  { id: 'qualification-only', version: 1, scope, execution: { image: candidateImage, dockerPath: '/usr/bin/docker', stateRoot: qualificationStateRoot, command: '/usr/local/bin/node /workspace/artifact < /workspace/input', artifactPath: 'topology.mjs', expiresAt: Date.now() + 120000, repeats: 2, maxToolCalls: 2, maxBytes: 4096, maxOutputBytes: 1024, cellDurationMs: 20000, verificationDurationMs: 10000 }, authority: { executable: process.execPath, args: ['--import', hook, cli, '--config', qualificationAuthorityConfig], publicKey: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest: topologyGeneratorDigest }, maxComparisons: 1 as const }] }
  await plugin.dispose(); plugin = await ctx.plugin(AssistantSkillsService, config)
  expect(await json('skill_comparison_status', {})).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'positive', executionTool: 'skill_qualify', canaryExecutionTool: 'skill_canary' }),
    expect.objectContaining({ id: 'qualification-only', executionTool: 'skill_qualify' }),
  ]))
  const sentinel = join(root, 'qualification-sentinel.txt'), artifact = join(root, 'topology.mjs')
  await writeFile(sentinel, 'source sentinel'); await writeFile(artifact, 'source artifact')
  const definitionsBeforeQualification = await json('skill_status', {})
  const qualified = await json('skill_qualify', { candidate_id: candidate.id, profile_id: 'qualification-only', invocation_id: 'qualification-only' })
  expect(qualified).toMatchObject({ candidateId: candidate.id, state: 'complete', quality: { candidateChecksPassed: true, evaluationGainObserved: true, criticalRegressionsPassed: true } })
  expect(await readFile(sentinel, 'utf8')).toBe('source sentinel'); expect(await readFile(artifact, 'utf8')).toBe('source artifact')
  expect(await json('skill_status', {})).toEqual(definitionsBeforeQualification)
  expect((await json('skill_candidates', {})).find((entry: { id: string }) => entry.id === candidate.id)).toMatchObject({ state: 'pending' })
  expect(await readFile(marker, 'utf8')).toBe('x')
  const expiresAt = Date.now() + 60000
  const completed = await execute('skill_canary', { candidate_id: candidate.id, profile_id: 'positive', invocation_id: 'once', owner_route_id: route.authorityId, expires_at: expiresAt, max_runs: 2, canary_runs: 1 }); expect(completed.isError).toBe(false)
  const deployed = JSON.parse((completed.value as { context: string }).context)
  expect(deployed).toMatchObject({ replayed: false, definition: { name: 'topology-order', version: 2, definitionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) }, deployment: { state: 'canary', comparisonId: expect.any(String), admissionDigest: acceptanceDigest(config.externalHoldouts[0]!.canaryAdmission!), taskFamilyDigest: acceptanceDigest(config.externalHoldouts[0]!.canaryAdmission!.taskFamily), runCount: 0 } })
  expect(await json('skill_comparison_status', { comparison_id: deployed.deployment.comparisonId })).toMatchObject({ state: 'complete', generatorDigest: topologyGeneratorDigest, admissionDigest: acceptanceDigest(config.externalHoldouts[0]!.canaryAdmission!), quality: { candidateChecksPassed: true, evaluationGain: 1, evaluationGainObserved: true, criticalRegressionsPassed: true, heldoutIndependence: 'attested-after-freeze' } })
  const sensitiveKeys = /"(?:scope|workspace|principalId|principalRecordId|principalVersion|sessionId|nativeGoalId|runId|routeReceipt|ownerRouteId|runIds|observations|input|publicKey|acceptance|receipt[^"]*)":/u
  expect(JSON.stringify(deployed)).not.toMatch(sensitiveKeys)
  expect(await readFile(marker, 'utf8')).toBe('xx'); expect(await json('skill_deployment_status', { deployment_id: deployed.deployment.id })).toMatchObject({ id: deployed.deployment.id, state: 'canary' })
  await plugin.dispose(); plugin = await ctx.plugin(AssistantSkillsService, config)
  const replayed = await json('skill_canary', { candidate_id: candidate.id, profile_id: 'positive', invocation_id: 'once', owner_route_id: route.authorityId, expires_at: expiresAt, max_runs: 2, canary_runs: 1 })
  expect(replayed).toMatchObject({ replayed: true, definition: { name: 'topology-order', version: 2 }, deployment: { id: deployed.deployment.id, state: 'canary', runCount: 0 } })
  expect(JSON.stringify(replayed)).not.toMatch(sensitiveKeys); expect(await readFile(marker, 'utf8')).toBe('xx')
  const firstRun = await json('skill_run', { goal_id: 'canary-goal', name: 'topology-order', version: 2, inputs_json: '{}', invocation_id: 'first-use' })
  expect(firstRun.state).toBe('succeeded'); expect(await readFile(join(root, 'topology.mjs'), 'utf8')).toBe(topologyImplementation)
  expect((await execute('skill_run', { goal_id: 'too-early', name: 'topology-order', version: 2, inputs_json: '{}', invocation_id: 'too-early' })).isError).toBe(true)
  expect(await json('skill_deployment_status', { deployment_id: deployed.deployment.id })).toMatchObject({ id: deployed.deployment.id, runCount: 1 })
  acceptRun(firstRun, true)
  await expect.poll(async () => (await json('skill_deployment_status', { deployment_id: deployed.deployment.id })).state).toBe('promoted')
  await plugin.dispose(); plugin = await ctx.plugin(AssistantSkillsService, config)
  const laterRun = await json('skill_run', { goal_id: 'later-goal', name: 'topology-order', version: 2, inputs_json: JSON.stringify({ implementation: wrongTopologyImplementation }), invocation_id: 'second-use' })
  expect(laterRun.state).toBe('succeeded'); expect(await readFile(join(root, 'topology.mjs'), 'utf8')).toBe(wrongTopologyImplementation)
  expect((await execute('skill_run', { goal_id: 'over-quota', name: 'topology-order', version: 2, inputs_json: '{}', invocation_id: 'over-quota' })).isError).toBe(true)
  acceptRun(laterRun, false)
  await expect.poll(async () => (await json('skill_deployment_status', { deployment_id: deployed.deployment.id })).state).toBe('rolled-back')
  expect((await json('skill_status', {}))[0].version).toBe(3)
  await plugin.dispose(); plugin = await ctx.plugin(AssistantSkillsService, config)
  const retry = await json('skill_canary', { candidate_id: candidate.id, profile_id: 'positive', invocation_id: 'once', owner_route_id: route.authorityId, expires_at: expiresAt, max_runs: 2, canary_runs: 1 })
  expect(retry).toMatchObject({ replayed: true, deployment: { state: 'rolled-back' } })
  expect(JSON.stringify(retry)).not.toMatch(sensitiveKeys)
  expect((await json('skill_status', {}))[0].version).toBe(3); expect(await readFile(marker, 'utf8')).toBe('xx')
}, 180000)
