import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { OwnerRepairAgentRuntime, type OwnerRepairAgentInput } from '../src/repair-agent.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function repairAgent(ctx: Context, workspace: string, id: SessionId): Agent {
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: workspace, agentPreset: 'repair' })
  const agent: Agent = { id, options: { provider: 'fixture', model: 'image-fixture' }, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }), ctx: undefined as unknown as Context,
    status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ;(agent as unknown as { ctx: Context }).ctx = createScope(ctx, agent).ctx
  return agent
}

test('native filesystem tools run through the production repair wrapper and reject outside and symlink paths', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'repair-native-workspace-'))
  const privateRoot = await mkdtemp(join(tmpdir(), 'repair-native-private-'))
  cleanups.push(async () => { await rm(workspace, { recursive: true, force: true }); await rm(privateRoot, { recursive: true, force: true }) })
  await mkdir(join(workspace, 'nested'))
  await writeFile(join(workspace, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J5sQAAAAASUVORK5CYII=', 'base64'))
  await writeFile(join(privateRoot, 'holdout.txt'), 'private bytes')
  await symlink(privateRoot, join(workspace, 'private-link'))

  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  let agent!: Agent
  let repairContext: Context | undefined
  ctx.provide('attachments' as never, {
    imageLimits: { maxImageBytes: 1024 * 1024, maxMessageImageBytes: 1024 * 1024, maxImageDimension: 1024, maxImagePixels: 1024 * 1024, mediaTypes: ['image/png'] },
    saveImage: async () => ({ attachmentId: 'test-image', mediaType: 'image/png', bytes: 68, width: 1, height: 1 }),
  } as never)
  ctx.provide('llm' as never, { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } as never)
  ctx.provide('assistantGoals' as never, { startOwnerAuthorizedRepair: async () => ({ id: 'goal' }) } as never)
  ctx.provide('assistantPolicy' as never, { bindInitiator: () => () => {} } as never)
  ctx.provide('agents' as never, { create: async ({ setup, sessionId }: { setup: (agentCtx: Context, prepared: Agent) => Promise<void>, sessionId: string }) => {
    if (repairContext === undefined) throw new Error('repair tools consumer is unavailable')
    agent = repairAgent(repairContext, workspace, SessionId(sessionId))
    await setup(agent.ctx, agent)
    return { agent, dispose: async () => {} }
  } } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  await ctx.plugin(FileTools)
  await ctx.inject(['tools'], consumer => { repairContext = consumer })
  if (repairContext === undefined) throw new Error('repair tools consumer did not activate')

  const scope = { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 1, workspace, preset: 'repair' }
  const trigger: OwnerRepairAgentInput['trigger'] = { protocol: 'assistant-skills/host-failure-trigger/v1', scope, taskFamily: { id: 'repair', definitionDigest: 'a'.repeat(64), objective: 'Repair artifact' }, failureCategory: 'objective-not-achieved', triggerCondition: { kind: 'not-achieved-count', minimumOccurrences: 1, windowStartedAt: 1, windowEndedAt: 1 }, failures: [], attestedAt: 1, evidence: { producer: 'assistant-goals', generation: 'test', digest: 'b'.repeat(64) } }
  const runtime = new OwnerRepairAgentRuntime(repairContext)
  cleanups.push(() => runtime.dispose())
  await runtime.create({ id: 'native-repair', authorizationDigest: 'digest', scope, ownerRouteId: 'route', trigger, objective: 'Repair artifact', maxGoalRounds: 1, expiresAt: Date.now() + 60_000, provider: 'fixture', model: 'image-fixture', maxModelCalls: 1, maxToolCalls: 16, maxOutputTokens: 128, maxDurationMs: 60_000, allowedTools: ['read', 'write', 'edit', 'read_image'], assertCurrent: () => {} })

  let call = 0
  const execute = async (name: string, arguments_: object) => await agent.ctx.tools.execute({ callId: ToolCallId(`native-${++call}`), name, arguments: arguments_, signal: new AbortController().signal, agent })
  expect((await execute('write', { file_path: 'nested/artifact.txt', content: 'before' })).isError).toBe(false)
  expect(await readFile(join(workspace, 'nested/artifact.txt'), 'utf8')).toBe('before')
  expect((await execute('read', { file_path: join(workspace, 'nested/artifact.txt') })).isError).toBe(false)
  expect((await execute('edit', { file_path: 'nested/artifact.txt', old_string: 'before', new_string: 'after' })).isError).toBe(false)
  expect(await readFile(join(workspace, 'nested/artifact.txt'), 'utf8')).toBe('after')
  expect((await execute('read_image', { file_path: 'image.png' })).isError).toBe(false)

  for (const [name, arguments_] of [
    ['read', { file_path: join(privateRoot, 'holdout.txt') }],
    ['write', { file_path: join(privateRoot, 'holdout.txt'), content: 'changed' }],
    ['edit', { file_path: 'private-link/holdout.txt', old_string: 'private bytes', new_string: 'changed' }],
    ['read_image', { file_path: 'private-link/holdout.txt' }],
  ] as const) {
    const result = await execute(name, arguments_)
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error(`native ${name} unexpectedly succeeded`)
    expect(result.error?.message).toMatch(/outside its workspace/u)
  }
  expect(await readFile(join(privateRoot, 'holdout.txt'), 'utf8')).toBe('private bytes')
})
