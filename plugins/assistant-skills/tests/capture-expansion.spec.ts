import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { captureRunExpansions } from '../src/capture-expansion.ts'
import { createDefinition } from '../src/definition.ts'
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
