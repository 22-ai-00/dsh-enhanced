import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { AssistantSkillsService } from '../src/service.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function agent(ctx: Context, workspace: string): Agent {
  const id = SessionId('owner-session')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: workspace, agentPreset: 'primary' })
  const value: Agent = { id, options: { provider: 'fixture', model: 'fixture' }, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }), ctx: undefined as unknown as Context,
    status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ;(value as unknown as { ctx: Context }).ctx = createScope(ctx, value).ctx
  session.append('turn/start', { turn: 1 })
  return value
}

async function fixture(options: { existing?: string; denyRead?: boolean; changeAfterRead?: boolean; allowedTools?: readonly string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-skills-file-observation-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  if (options.existing !== undefined) await writeFile(join(root, 'artifact.txt'), options.existing)
  const ctx = new Context(); cleanups.push(() => ctx.fiber.restart())
  const owner = agent(ctx, root)
  const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace: root, preset: 'primary' }
  const source = { protocol: 'assistant-goals/verified-workflow-source/v1' as const, scope,
    goal: { id: 'source-goal', definition: { version: 1, digest: 'a'.repeat(64), objective: 'write artifact' }, sessionId: String(owner.session.id), nativeGoalId: 'native-source' },
    runId: 'source-run', turn: 1, acceptance: { contractId: 'contract', contractDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), verifiedAt: 1, validUntil: 2 },
    steps: [{ id: 'write-artifact', toolName: 'write', arguments: { file_path: 'artifact.txt', content: 'skill-content' } }] }
  ctx.provide('agents' as never, { get: (id: string) => id === owner.id ? owner : undefined, list: () => [owner] } as never)
  const principal = { principalId: 'owner', principalLineage: { principalRecordId: 'owner-record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } }
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: () => principal, currentPreferenceTurn: () => principal } as never)
  ctx.provide('assistantPolicy' as never, { evaluateAgent: () => ({ effect: 'allow' }), authorizeAgent: () => ({ effect: 'allow' }), evaluate: () => ({ effect: 'allow' }), authorize: () => ({ effect: 'allow' }) } as never)
  ctx.provide('assistantVerifier' as never, {} as never)
  ctx.provide('assistantGoals' as never, { inspectVerifiedWorkflowSource: () => source,
    inspectWorkflowRunContext: (_agent: Agent, goalId: string) => ({ scope, goalId, sessionId: String(owner.session.id), goalExecutionRunId: `execution-${goalId}`, nativeGoalId: `native-${goalId}`, definition: { version: 1, digest: 'd'.repeat(64) } }) } as never)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(LocalFileSystem, { cwd: root }); await ctx.plugin(FsPolicy); await ctx.plugin(FileTools); await ctx.plugin(SkillRegistry)
  await ctx.plugin(AssistantSkillsService, { databasePath: join(root, 'skills.sqlite'), allowedTools: [...(options.allowedTools ?? ['read', 'write', 'edit'])] })
  const calls: { name: string; callId: string; rootCallId: string; arguments: unknown; token: unknown; parent: unknown }[] = []
  const prepared: string[] = []
  ctx.on('tools/execute', async (exec, next) => {
    calls.push({ name: exec.name, callId: String(exec.callId), rootCallId: String(exec.rootCallId), arguments: exec.arguments, token: exec.token, parent: exec.parent })
    const value = await next()
    if (options.changeAfterRead && exec.name === 'read' && String(exec.callId).includes(':skill-observation:')) await writeFile(join(root, 'artifact.txt'), 'external-change')
    return value
  })
  ctx.on('tools/pre-execute', async (exec, next) => { prepared.push(exec.name); return options.denyRead && exec.name === 'read' ? { kind: 'deny', reason: 'read permission revoked' } : next() })
  const saved = await owner.ctx.get('tools')!.execute({ callId: ToolCallId('save-definition'), name: 'skill_save', arguments: { goal_id: 'source-goal', name: 'write-artifact', description: 'Write the artifact.', bindings_json: '[]', expected_version: 0 }, signal: new AbortController().signal, agent: owner })
  if (saved.isError) throw new Error(`skill save fixture failed: ${saved.error.message}`)
  const savedDefinition = JSON.parse((saved.value as { context: string }).context)
  const run = async (invocationId: string, signal = new AbortController().signal) => owner.ctx.get('tools')!.execute({ callId: ToolCallId(`root-${invocationId}`), name: 'skill_run', arguments: { goal_id: 'new-goal', name: 'write-artifact', version: 1, inputs_json: '{}', invocation_id: invocationId }, signal, agent: owner })
  return { root, ctx, scope, sessionId: String(owner.session.id), calls, prepared, run, savedDefinition }
}

function response(value: { isError: boolean; value?: unknown }) { return value.isError ? undefined : JSON.parse((value.value as { context: string }).context) }
function persistedRun(input: { root: string; scope: object; sessionId: string }, invocationId: string) {
  const database = new DatabaseSync(join(input.root, 'skills.sqlite'))
  try {
    const id = `skill-run-${acceptanceDigest([input.scope, input.sessionId, invocationId])}`
    const row = database.prepare('SELECT run_json FROM skill_runs WHERE id=?').get(id) as { run_json: string } | undefined
    expect(row, `missing durable run ${id}`).toBeDefined()
    return JSON.parse(row!.run_json) as { state: string; steps: { id: string; state: string; detail?: string }[] }
  } finally { database.close() }
}

test('uses a native absent read before creating and checkpoints it under the skill root call', async () => {
  const f = await fixture()
  expect(f.savedDefinition).toMatchObject({ fileObservations: { protocol: 'assistant-skills/file-observations/v1', beforeSteps: ['write-artifact'] } })
  const value = await f.run('create')
  expect(response(value)).toMatchObject({ state: 'succeeded', steps: [{ id: 'file-observation:1', state: 'succeeded', detail: 'absence:FS_NOT_FOUND' }, { id: 'write-artifact', state: 'succeeded' }] })
  expect(await readFile(join(f.root, 'artifact.txt'), 'utf8')).toBe('skill-content')
  const root = f.calls.find(call => call.name === 'skill_run')!
  const read = f.calls.find(call => call.name === 'read')!, write = f.calls.find(call => call.name === 'write')!
  expect(read).toMatchObject({ callId: 'root-create:skill-observation:1', rootCallId: 'root-create', arguments: { file_path: 'artifact.txt', limit: 1 } })
  expect(write).toMatchObject({ callId: 'root-create:skill:1', rootCallId: 'root-create', arguments: { file_path: 'artifact.txt', content: 'skill-content' } })
  expect(read.parent).toBe(root.token); expect(write.parent).toBe(root.token)
})

test('reads an existing file then uses the real observed-version CAS write', async () => {
  const f = await fixture({ existing: 'old' })
  expect(response(await f.run('replace'))).toMatchObject({ state: 'succeeded', steps: [{ id: 'file-observation:1', state: 'succeeded' }, { id: 'write-artifact', state: 'succeeded' }] })
  expect(await readFile(join(f.root, 'artifact.txt'), 'utf8')).toBe('skill-content')
})

test('stops before writing when the nested observation loses current read permission', async () => {
  const f = await fixture({ denyRead: true, existing: 'old' })
  const value = await f.run('read-denied')
  expect(value.isError).toBe(true)
  expect(await readFile(join(f.root, 'artifact.txt'), 'utf8')).toBe('old')
  expect(f.prepared).toContain('read')
  expect(f.calls.map(call => call.name)).not.toContain('write')
})

test('refuses a newly declared write skill when its current allowlist no longer includes read', async () => {
  const f = await fixture({ allowedTools: ['write'] })
  expect(f.savedDefinition.fileObservations).toEqual({ protocol: 'assistant-skills/file-observations/v1', beforeSteps: ['write-artifact'] })
  const value = await f.run('write-only')
  expect(value.isError).toBe(true)
  await expect(readFile(join(f.root, 'artifact.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.calls.map(call => call.name)).not.toContain('read')
  expect(f.calls.map(call => call.name)).not.toContain('write')
})

test('stops when an external change makes the observed write version stale', async () => {
  const f = await fixture({ existing: 'old', changeAfterRead: true })
  const value = await f.run('stale')
  expect(value.isError).toBe(true)
  expect(persistedRun(f, 'stale')).toMatchObject({ state: 'failed', steps: [{ id: 'file-observation:1', state: 'succeeded' }, { id: 'write-artifact', state: 'failed', detail: 'FS_STALE_VERSION' }] })
  expect(await readFile(join(f.root, 'artifact.txt'), 'utf8')).toBe('external-change')
  expect(f.calls.map(call => call.name)).toEqual(expect.arrayContaining(['read', 'write']))
})

test('records an aborted observation invocation as unknown and never replays it', async () => {
  const f = await fixture({ existing: 'old' })
  const controller = new AbortController()
  f.ctx.on('tools/execute', async (exec, next) => {
    const value = await next()
    if (exec.name === 'read' && String(exec.callId).includes(':skill-observation:')) controller.abort()
    return value
  })
  const first = await f.run('abort-once', controller.signal)
  expect(first.isError).toBe(true)
  expect(persistedRun(f, 'abort-once')).toMatchObject({ state: 'unknown' })
  expect(await readFile(join(f.root, 'artifact.txt'), 'utf8')).toBe('old')
  const writes = f.calls.filter(call => call.name === 'write').length
  const duplicate = await f.run('abort-once')
  expect(duplicate.isError).toBe(true)
  expect(f.calls.filter(call => call.name === 'write')).toHaveLength(writes)
  expect(await readFile(join(f.root, 'artifact.txt'), 'utf8')).toBe('old')
})
