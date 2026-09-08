import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createDefinition } from '../src/definition.ts'
import { replaySkill } from '../src/replay.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function root() { const value = await mkdtemp(join(tmpdir(), 'skills-replay-')); roots.push(value); return value }
function definition(steps: { id: string; toolName: string; arguments: unknown }[]) {
  const workspace = '/source-workspace'; const source = { protocol: 'assistant-goals/verified-workflow-source/v1' as const, scope: { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace, preset: 'primary' }, goal: { id: 'source', definition: { version: 1, digest: 'a'.repeat(64), objective: 'source' }, sessionId: 'session', nativeGoalId: 'native' }, runId: 'run', turn: 1, acceptance: { contractId: 'contract', contractDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), verifiedAt: 1, validUntil: 2 }, steps }
  return createDefinition(source, { name: 'replay-file', description: 'Replay files.', bindings: steps[0]?.toolName === 'write' ? [{ name: 'message', stepId: steps[0]!.id, path: '/content' }] : [] }, ['read', 'write', 'edit'])
}
async function replay(definitionValue: ReturnType<typeof definition>, stateRoot: string, options: Partial<Parameters<typeof replaySkill>[0]> = {}) { return replaySkill({ definition: definitionValue, inputs: definitionValue.inputs.length ? { message: 'bound' } : {}, files: [], artifactPath: 'artifact.txt', stateRoot, maxToolCalls: 32, maxBytes: 100000, signal: new AbortController().signal, authorize() {}, ...options }) }

test('replays native write, read, and edit in a temporary workspace with bound input', async () => {
  const stateRoot = await root(); const value = definition([{ id: 'write', toolName: 'write', arguments: { file_path: 'artifact.txt', content: 'original' } }, { id: 'read', toolName: 'read', arguments: { file_path: 'artifact.txt' } }, { id: 'edit', toolName: 'edit', arguments: { file_path: 'artifact.txt', old_string: 'bound', new_string: 'edited' } }])
  await expect(replay(value, stateRoot)).resolves.toMatchObject({ artifact: 'edited', toolCalls: 3, quiescent: true, steps: [{ toolName: 'write' }, { toolName: 'read' }, { toolName: 'edit' }] })
  expect(await readdir(stateRoot)).toEqual([])
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

test('honors abort before dispatch and removes the private workspace', async () => {
  const stateRoot = await root(); const controller = new AbortController(); controller.abort()
  const value = definition([{ id: 'write', toolName: 'write', arguments: { file_path: 'artifact.txt', content: 'x' } }])
  await expect(replay(value, stateRoot, { signal: controller.signal })).rejects.toThrow()
  expect(await readdir(stateRoot)).toEqual([])
})
