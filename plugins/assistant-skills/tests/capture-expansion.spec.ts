import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { captureFailureCandidateProvenance, captureRunExpansions } from '../src/capture-expansion.ts'
import { createDefinition, failureSummaryEvidenceDigest, validateFailureCaptureProvenance, validateHostFailureEvidenceSummary,
  type HostFailureEvidenceSummary, type VerifiedWorkflowSource } from '../src/definition.ts'
import { SkillStore } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const digest = (letter: string) => letter.repeat(64)

async function fixture(options: { state?: 'succeeded' | 'failed' | 'unknown'; checkpoint?: 'valid' | 'invalid'; retire?: boolean; nativeGoal?: 'missing' | 'wrong' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-skills-capture-expansion-')); roots.push(root)
  const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, preset: 'primary' }
  const sourceGoal = { id: 'source-goal', definition: { version: 1, digest: digest('a'), objective: 'source objective' }, sessionId: 'owner-session', nativeGoalId: 'native-source' }
  const sourceRunId = 'goal-run-source'
  const store = new SkillStore(join(root, 'skills.sqlite'))
  const saved = store.save(scope, createDefinition({ protocol: 'assistant-goals/verified-workflow-source/v1', scope,
    goal: { id: 'saved-source', definition: { version: 1, digest: digest('b'), objective: 'saved writer' }, sessionId: 'owner-session', nativeGoalId: 'native-saved' }, runId: 'saved-run', turn: 1,
    acceptance: { contractId: 'contract', contractDigest: digest('c'), receiptDigest: digest('d'), verifiedAt: 1, validUntil: 2 },
    steps: [{ id: 'write', toolName: 'write', arguments: { file_path: 'artifact.txt', content: 'saved' } }] },
  { name: 'saved-writer', description: 'Write a saved artifact.', bindings: [{ name: 'message', stepId: 'write', path: '/content' }] }, ['read', 'write']), 0)
  const input = { message: 'bound' }
  const invocationId = 'reuse-once'
  const claim = store.claim(scope, { invocationId, goalId: sourceGoal.id, sessionId: sourceGoal.sessionId, skillName: saved.name, version: saved.version, inputs: input,
    goalExecutionRunId: sourceRunId, goalDefinitionDigest: sourceGoal.definition.digest,
    ...(options.nativeGoal === 'missing' ? {} : { nativeGoalId: options.nativeGoal === 'wrong' ? 'foreign-native' : sourceGoal.nativeGoalId }) })
  const steps = options.checkpoint === 'invalid'
    ? [{ id: 'write', state: 'succeeded' as const, detail: `result:${digest('e')}` }]
    : [{ id: 'file-observation:1', state: 'succeeded' as const, detail: 'absence:FS_NOT_FOUND' }, { id: 'write', state: 'succeeded' as const, detail: `result:${digest('e')}` }]
  store.finish(scope, claim.run.id, options.state ?? 'succeeded', steps)
  if (options.retire) store.retire(scope, saved.name, saved.version)
  const source = { protocol: 'assistant-goals/verified-workflow-source/v1' as const, scope, goal: sourceGoal, runId: sourceRunId, turn: 1,
    acceptance: { contractId: 'source-contract', contractDigest: digest('f'), receiptDigest: digest('0'), verifiedAt: 1, validUntil: 2 },
    steps: [{ id: 'outer-skill-run', toolName: 'skill_run', arguments: { goal_id: sourceGoal.id, name: saved.name, version: saved.version, inputs_json: JSON.stringify(input), invocation_id: invocationId } }] }
  return { root, store, scope, source, saved, sourceGoal, sourceRunId, input, invocationId }
}

test('expands only a successful exact stored skill run with its native checkpoint proof', async () => {
  const f = await fixture()
  const [proof] = captureRunExpansions(f.source, f.scope, f.store)
  expect(proof).toMatchObject({ protocol: 'assistant-skills/run-expansion/v1', callId: 'outer-skill-run', runId: expect.stringMatching(/^skill-run-/u), steps: [{ id: 'write', toolName: 'write', arguments: { file_path: 'artifact.txt', content: 'bound' } }] })
  expect(proof!.steps).toHaveLength(1)
  expect(proof!.inputsDigest).toMatch(/^[a-f0-9]{64}$/u)
})

test('captures two distinct executions of the same skill with their own bound inputs', async () => {
  const f = await fixture()
  const inputs = { message: 'second' }
  const claim = f.store.claim(f.scope, { invocationId: 'reuse-twice', goalId: f.sourceGoal.id, sessionId: f.sourceGoal.sessionId,
    skillName: f.saved.name, version: f.saved.version, inputs, goalExecutionRunId: f.sourceRunId,
    goalDefinitionDigest: f.sourceGoal.definition.digest, nativeGoalId: f.sourceGoal.nativeGoalId })
  f.store.finish(f.scope, claim.run.id, 'succeeded', [
    { id: 'file-observation:1', state: 'succeeded', detail: `result:${digest('e')}` },
    { id: 'write', state: 'succeeded', detail: `result:${digest('f')}` },
  ])
  const source = { ...f.source, steps: [...f.source.steps, { ...f.source.steps[0]!, id: 'second-outer-call',
    arguments: { ...f.source.steps[0]!.arguments, invocation_id: 'reuse-twice', inputs_json: JSON.stringify(inputs) } }] }
  const proofs = captureRunExpansions(source, f.scope, f.store)
  const definition = createDefinition(source, { name: 'combined', description: 'Two actual writes.' }, ['read', 'write'], proofs)
  const saved = f.store.save(f.scope, definition, 0)
  const restored = f.store.get(f.scope, saved.name)!
  expect(restored.steps.map(step => step.arguments)).toEqual([
    { file_path: 'artifact.txt', content: 'bound' }, { file_path: 'artifact.txt', content: 'second' },
  ])
  expect(new Set(restored.steps.map(step => step.id)).size).toBe(2)
  expect(restored.steps[1]!.dependsOn).toEqual([restored.steps[0]!.id])
  expect(restored.fileObservations?.beforeSteps).toEqual(restored.steps.map(step => step.id))
  expect(restored.runExpansions).toEqual(proofs)
})

test('never turns an idempotent response for one invocation into two executions', async () => {
  const f = await fixture()
  const source = { ...f.source, steps: [...f.source.steps, { ...f.source.steps[0]!, id: 'retry-outer-call' }] }
  expect(() => captureRunExpansions(source, f.scope, f.store)).toThrow(/duplicate source skill_run execution/u)
  const [proof] = captureRunExpansions(f.source, f.scope, f.store)
  expect(() => createDefinition(source, { name: 'duplicate-run', description: 'Reject duplicate execution proof.' }, ['read', 'write'],
    [proof!, { ...proof!, callId: 'retry-outer-call' }])).toThrow(/invalid run expansion/u)
})

test.each([
  ['wrong goal', (f: Awaited<ReturnType<typeof fixture>>) => ({ ...f.source, steps: [{ ...f.source.steps[0]!, arguments: { ...(f.source.steps[0]!.arguments as object), goal_id: 'other-goal' } }] })],
  ['wrong session', (f: Awaited<ReturnType<typeof fixture>>) => ({ ...f.source, goal: { ...f.source.goal, sessionId: 'other-session' } })],
  ['wrong inputs', (f: Awaited<ReturnType<typeof fixture>>) => ({ ...f.source, steps: [{ ...f.source.steps[0]!, arguments: { ...(f.source.steps[0]!.arguments as object), inputs_json: '{"message":"other"}' } }] })],
  ['wrong version', (f: Awaited<ReturnType<typeof fixture>>) => ({ ...f.source, steps: [{ ...f.source.steps[0]!, arguments: { ...(f.source.steps[0]!.arguments as object), version: 2 } }] })],
  ['nested source call', (f: Awaited<ReturnType<typeof fixture>>) => ({ ...f.source, steps: [{ ...f.source.steps[0]!, id: 'outer:skill:1' }] })],
  ['duplicate source skill_run', (f: Awaited<ReturnType<typeof fixture>>) => ({ ...f.source, steps: [f.source.steps[0]!, f.source.steps[0]!] })],
] as const)('rejects %s proof mismatches', async (_name, alter) => {
  const f = await fixture()
  expect(() => captureRunExpansions(alter(f), f.scope, f.store)).toThrow(/expansion|nested|duplicate/u)
})

test.each([
  ['failed', { state: 'failed' as const }],
  ['unknown', { state: 'unknown' as const }],
  ['missing checkpoint', { checkpoint: 'invalid' as const }],
  ['retired definition', { retire: true }],
  ['missing native Goal', { nativeGoal: 'missing' as const }],
  ['wrong native Goal', { nativeGoal: 'wrong' as const }],
] as const)('rejects %s stored run proof', async (_name, options) => {
  const f = await fixture(options)
  expect(() => captureRunExpansions(f.source, f.scope, f.store)).toThrow(/expansion|checkpoint/u)
})

function failureCaptureFixture() {
  const objective = 'Normalize newline-delimited records.'
  const definitionDigest = acceptanceDigest({ objective })
  const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/tmp/failure-capture', preset: 'primary' }
  const repairGoal = { id: 'repair-goal', definition: { version: 1, digest: definitionDigest, objective }, sessionId: 'repair-session', nativeGoalId: 'repair-native' }
  const repair: VerifiedWorkflowSource = { protocol: 'assistant-goals/verified-workflow-source/v1', scope, goal: repairGoal, runId: 'repair-run', turn: 3,
    acceptance: { contractId: 'repair-contract', contractDigest: digest('b'), receiptDigest: digest('c'), verifiedAt: 30, validUntil: 60 },
    steps: [{ id: 'read', toolName: 'read', arguments: { file_path: 'records.ndjson' } }, { id: 'write', toolName: 'write', arguments: { file_path: 'normalized.ndjson', content: 'fixed' } }] }
  const failure = (index: number) => ({ goal: { id: `failed-goal-${index}`, definition: { version: 1, digest: definitionDigest, objective },
    sessionId: `failed-session-${index}`, nativeGoalId: `failed-native-${index}` }, runId: `failed-run-${index}`, execution: { status: 'succeeded' as const, quiescent: true as const },
    outcome: 'not-achieved' as const, acceptance: { contractId: `failed-contract-${index}`, contractDigest: digest('d'), receiptDigest: digest('e'), verifiedAt: 10 + index, validUntil: 50 }, traceDigest: digest('f') })
  const unsigned = { protocol: 'assistant-skills/host-failure-evidence/v1' as const, scope, taskFamily: { id: 'ndjson-normalization', definitionDigest, objective },
    failureCategory: 'repeated-not-achieved' as const, triggerCondition: { kind: 'not-achieved-count' as const, minimumOccurrences: 2, windowStartedAt: 10, windowEndedAt: 20 },
    failures: [failure(1), failure(2)], repairGoal, attestedAt: 35 }
  const generation = 'goals-generation-1'
  const trigger: HostFailureEvidenceSummary = { ...unsigned, evidence: { producer: 'assistant-goals', generation, digest: failureSummaryEvidenceDigest(unsigned, generation) } }
  const base = (name: string, source: VerifiedWorkflowSource) => createDefinition(source, { name, description: 'Normalize records.' }, ['read', 'write', 'edit'], [])
  const parent = { ...base('normalize-records', { ...repair, goal: { ...repair.goal, id: 'parent-source', sessionId: 'parent-session', nativeGoalId: 'parent-native' }, runId: 'parent-run', steps: [{ id: 'read', toolName: 'read', arguments: { file_path: 'records.ndjson' } }] }),
    version: 1, parentVersion: null, retired: false, createdAt: 1, updatedAt: 1 }
  const candidate = base('normalize-records', repair)
  return { scope, trigger, repair, parent, candidate }
}

test('binds repeated Host-attested task failures to a later independent achieved repair and exact rollback target', () => {
  const f = failureCaptureFixture()
  const captured = captureFailureCandidateProvenance(f.trigger, f.repair, f.scope, f.parent, f.candidate)
  expect(captured).toMatchObject({ protocol: 'assistant-skills/failure-capture-provenance/v1',
    trigger: { failureCategory: 'repeated-not-achieved', triggerCondition: { minimumOccurrences: 2 }, failures: [{ outcome: 'not-achieved' }, { outcome: 'not-achieved' }] },
    repair: { goal: { id: 'repair-goal' }, runId: 'repair-run' }, parent: { name: 'normalize-records', version: 1 },
    permissionDelta: { parent: ['read'], candidate: ['read', 'write'], added: ['write'], removed: [], expandsAuthority: true },
    rollbackTarget: { name: 'normalize-records', version: 1 } })
  expect(captured.rollbackTarget).toEqual(captured.parent)
  expect(validateFailureCaptureProvenance(captured)).toEqual(captured)
})

test.each([
  ['failed execution', (f: ReturnType<typeof failureCaptureFixture>) => ({ ...f.trigger, failures: f.trigger.failures.map((failure, index) => index ? failure : { ...failure, execution: { status: 'failed', quiescent: true } }) })],
  ['unknown execution', (f: ReturnType<typeof failureCaptureFixture>) => ({ ...f.trigger, failures: f.trigger.failures.map((failure, index) => index ? failure : { ...failure, execution: { status: 'unknown', quiescent: false } }) })],
  ['achieved outcome', (f: ReturnType<typeof failureCaptureFixture>) => ({ ...f.trigger, failures: f.trigger.failures.map((failure, index) => index ? failure : { ...failure, outcome: 'achieved' }) })],
  ['changed evidence digest', (f: ReturnType<typeof failureCaptureFixture>) => ({ ...f.trigger, evidence: { ...f.trigger.evidence, digest: digest('0') } })],
] as const)('rejects a %s as Host failure evidence', (_name, alter) => {
  const f = failureCaptureFixture()
  expect(() => validateHostFailureEvidenceSummary(alter(f))).toThrow(/failure|evidence/u)
})

test.each([
  ['same Goal', (f: ReturnType<typeof failureCaptureFixture>) => ({ ...f.repair, goal: { ...f.repair.goal, id: f.trigger.failures[0]!.goal.id } })],
  ['same Session', (f: ReturnType<typeof failureCaptureFixture>) => ({ ...f.repair, goal: { ...f.repair.goal, sessionId: f.trigger.failures[0]!.goal.sessionId } })],
  ['same native Goal', (f: ReturnType<typeof failureCaptureFixture>) => ({ ...f.repair, goal: { ...f.repair.goal, nativeGoalId: f.trigger.failures[0]!.goal.nativeGoalId } })],
  ['same run', (f: ReturnType<typeof failureCaptureFixture>) => ({ ...f.repair, runId: f.trigger.failures[0]!.runId })],
  ['not later', (f: ReturnType<typeof failureCaptureFixture>) => ({ ...f.repair, acceptance: { ...f.repair.acceptance, verifiedAt: f.trigger.failures[0]!.acceptance.verifiedAt, validUntil: 60 } })],
  ['other task family', (f: ReturnType<typeof failureCaptureFixture>) => ({ ...f.repair, goal: { ...f.repair.goal, definition: { ...f.repair.goal.definition, objective: 'Unrelated task.', digest: acceptanceDigest({ objective: 'Unrelated task.' }) } } })],
] as const)('rejects a %s repair trace', (_name, alter) => {
  const f = failureCaptureFixture(), repair = alter(f) as VerifiedWorkflowSource
  const trigger = { ...f.trigger, repairGoal: repair.goal }
  const unsigned = (({ evidence: _evidence, ...value }) => value)(trigger)
  trigger.evidence = { ...trigger.evidence, digest: failureSummaryEvidenceDigest(unsigned, trigger.evidence.generation) }
  expect(() => captureFailureCandidateProvenance(trigger, repair, f.scope, f.parent, { ...f.candidate, source: repair })).toThrow(/independent|later|failure|invalid/u)
})

test('rejects changed parent rollback and permission-delta claims', () => {
  const f = failureCaptureFixture(), captured = captureFailureCandidateProvenance(f.trigger, f.repair, f.scope, f.parent, f.candidate)
  expect(() => validateFailureCaptureProvenance({ ...captured, rollbackTarget: { ...captured.rollbackTarget, version: 2 } })).toThrow(/parent|rollback/u)
  expect(() => validateFailureCaptureProvenance({ ...captured, permissionDelta: { ...captured.permissionDelta, added: [], expandsAuthority: false } })).toThrow(/permission/u)
})
