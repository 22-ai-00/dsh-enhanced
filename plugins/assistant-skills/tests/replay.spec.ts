import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createDefinition } from '../src/definition.ts'
import { replaySkill } from '../src/replay.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function root() { const value = await mkdtemp(join(tmpdir(), 'skills-replay-')); roots.push(value); return value }
function definition(steps: { id: string; toolName: string; arguments: unknown }[], allowedTools: readonly string[] = ['read', 'write', 'edit']) {
  const workspace = '/source-workspace'; const source = { protocol: 'assistant-goals/verified-workflow-source/v1' as const, scope: { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace, preset: 'primary' }, goal: { id: 'source', definition: { version: 1, digest: 'a'.repeat(64), objective: 'source' }, sessionId: 'session', nativeGoalId: 'native' }, runId: 'run', turn: 1, acceptance: { contractId: 'contract', contractDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), verifiedAt: 1, validUntil: 2 }, steps }
  return createDefinition(source, { name: 'replay-file', description: 'Replay files.', bindings: steps[0]?.toolName === 'write' ? [{ name: 'message', stepId: steps[0]!.id, path: '/content' }] : [] }, allowedTools)
}
async function replay(definitionValue: ReturnType<typeof definition>, stateRoot: string, options: Partial<Parameters<typeof replaySkill>[0]> = {}) { return replaySkill({ definition: definitionValue, inputs: definitionValue.inputs.length ? { message: 'bound' } : {}, files: [], artifactPath: 'artifact.txt', stateRoot, maxToolCalls: 32, maxBytes: 100000, signal: new AbortController().signal, authorize() {}, ...options }) }

test('replays native write, read, and edit in a temporary workspace with bound input', async () => {
  const stateRoot = await root(); const value = definition([{ id: 'write', toolName: 'write', arguments: { file_path: 'artifact.txt', content: 'original' } }, { id: 'read', toolName: 'read', arguments: { file_path: 'artifact.txt' } }, { id: 'edit', toolName: 'edit', arguments: { file_path: 'artifact.txt', old_string: 'bound', new_string: 'edited' } }])
  await expect(replay(value, stateRoot)).resolves.toMatchObject({ artifact: 'edited', toolCalls: 5, quiescent: true, steps: [{ toolName: 'read' }, { toolName: 'write' }, { toolName: 'read' }, { toolName: 'read' }, { toolName: 'edit' }] })
  expect(await readdir(stateRoot)).toEqual([])
})

test('omits bounded provenance observations while preserving their trace positions and budget', async () => {
  const stateRoot = await root()
  const value = definition([
    { id: 'glob', toolName: 'glob', arguments: { path: '/source-workspace', pattern: '**/*.txt' } },
    { id: 'write', toolName: 'write', arguments: { file_path: 'artifact.txt', content: 'captured' } },
    { id: 'read', toolName: 'read', arguments: { file_path: 'artifact.txt' } },
    { id: 'goal', toolName: 'get_goal', arguments: {} },
  ], ['glob', 'write', 'read', 'get_goal'])
  await expect(replay(value, stateRoot)).resolves.toMatchObject({ artifact: 'captured', toolCalls: 5, executedToolCalls: 3, omittedObservations: 2,
    steps: [
      { id: 'glob', outcome: 'omitted-observation', observation: 'provenance-only' },
      { id: 'file-observation:1', toolName: 'read', outcome: 'executed' },
      { id: 'write', outcome: 'executed' }, { id: 'read', outcome: 'executed' },
      { id: 'goal', outcome: 'omitted-observation', observation: 'provenance-only' },
    ] })
})

test('accepts a bounded same-workspace grep as a provenance-only observation', async () => {
  const stateRoot = await root()
  const value = definition([
    { id: 'grep', toolName: 'grep', arguments: { path: '/source-workspace/src', pattern: 'TODO', include: '**/*.ts' } },
    { id: 'write', toolName: 'write', arguments: { file_path: 'artifact.txt', content: 'captured' } },
  ], ['grep', 'write'])
  await expect(replay(value, stateRoot)).resolves.toMatchObject({ artifact: 'captured', toolCalls: 3, executedToolCalls: 2, omittedObservations: 1,
    steps: [{ id: 'grep', outcome: 'omitted-observation', observation: 'provenance-only' }, { id: 'file-observation:1', toolName: 'read', outcome: 'executed' }, { id: 'write', outcome: 'executed' }] })
})

test('rejects external paths, limits, failed edits, and revocation', async () => {
  const stateRoot = await root(); const outside = definition([{ id: 'write', toolName: 'write', arguments: { file_path: '/outside.txt', content: 'x' } }])
  await expect(replay(outside, stateRoot)).rejects.toThrow(/external path/)
  const edit = definition([{ id: 'edit', toolName: 'edit', arguments: { file_path: 'artifact.txt', old_string: 'missing', new_string: 'x' } }])
  await expect(replay(edit, stateRoot, { files: [{ path: 'artifact.txt', content: 'present' }] })).rejects.toThrow(/edit failed/)
  const write = definition([{ id: 'write', toolName: 'write', arguments: { file_path: 'artifact.txt', content: 'x' } }])
  await expect(replay(write, stateRoot, { maxToolCalls: 0 })).rejects.toThrow(/tool-call limit/)
  await expect(replay(write, stateRoot, { maxBytes: 1 })).rejects.toThrow(/byte limit/)
  await expect(replay(write, stateRoot, { authorize: () => { throw new Error('revoked') } })).rejects.toThrow(/revoked/)
})

test('rejects malformed, escaping, control, unknown, and duplicate captured steps', async () => {
  const stateRoot = await root()
  const base = definition([{ id: 'read', toolName: 'read', arguments: { file_path: 'artifact.txt' } }])
  const altered = (steps: unknown) => ({ ...JSON.parse(JSON.stringify(base)), steps }) as ReturnType<typeof definition>
  await expect(replay(altered([{ id: 'goal', toolName: 'get_goal', arguments: { id: 'native' } }]), stateRoot)).rejects.toThrow(/invalid get_goal observation/)
  await expect(replay(altered([{ id: 'glob', toolName: 'glob', arguments: { path: '../outside', pattern: '**/*' } }]), stateRoot)).rejects.toThrow(/observation path/)
  await expect(replay(altered([{ id: 'control', toolName: 'create_goal', arguments: {} }]), stateRoot)).rejects.toThrow(/invalid tool/)
  await expect(replay(altered([{ id: 'unknown', toolName: 'bash', arguments: {} }]), stateRoot)).rejects.toThrow(/invalid tool/)
  await expect(replay(altered([
    { id: 'same', toolName: 'write', arguments: { file_path: 'artifact.txt', content: 'x' } },
    { id: 'same', toolName: 'get_goal', arguments: {} },
  ]), stateRoot)).rejects.toThrow(/invalid trace/)
})

test('honors abort before dispatch and removes the private workspace', async () => {
  const stateRoot = await root(); const controller = new AbortController(); controller.abort()
  const value = definition([{ id: 'write', toolName: 'write', arguments: { file_path: 'artifact.txt', content: 'x' } }])
  await expect(replay(value, stateRoot, { signal: controller.signal })).rejects.toThrow()
  expect(await readdir(stateRoot)).toEqual([])
})


test('counts declared file observations against the comparison budget before dispatch', async () => {
  const stateRoot = await root()
  const value = definition([{ id: 'write', toolName: 'write', arguments: { file_path: 'artifact.txt', content: 'original' } }])
  await expect(replay(value, stateRoot, { maxToolCalls: 1 })).rejects.toThrow(/tool-call limit/)
  expect(await readdir(stateRoot)).toEqual([])
  await expect(replay(value, stateRoot, { maxToolCalls: 2 })).resolves.toMatchObject({ artifact: 'bound', toolCalls: 2, executedToolCalls: 2,
    steps: [{ id: 'file-observation:1', toolName: 'read' }, { id: 'write', toolName: 'write' }] })
  await expect(replay(value, stateRoot, { files: [{ path: 'artifact.txt', content: 'existing' }], maxToolCalls: 2 })).resolves.toMatchObject({ artifact: 'bound', toolCalls: 2 })
  const edit = definition([{ id: 'edit', toolName: 'edit', arguments: { file_path: 'artifact.txt', old_string: 'a', new_string: 'b' } }])
  await expect(replay(edit, stateRoot)).rejects.toThrow(/read failed/)
  const legacy = { ...value }; delete legacy.fileObservations
  await expect(replay(legacy, stateRoot, { maxToolCalls: 1 })).resolves.toMatchObject({ artifact: 'bound', toolCalls: 1 })
})
