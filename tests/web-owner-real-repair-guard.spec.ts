import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test, vi } from 'vitest'
import { Context } from '../plugins/assistant-goals/node_modules/@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '../plugins/assistant-goals/node_modules/@deepseek-ai/dsh-tools'
import { ToolCallId } from '../plugins/assistant-goals/node_modules/@deepseek-ai/dsh-llm'
import SystemPrompt from '../plugins/assistant-goals/node_modules/@deepseek-ai/dsh-system-prompt'

const { apply, createRunGuard, logState, readControl, toolAllowed } = await import('../scripts/e2e/web-owner-real-repair-guard.mjs')

async function fixture(value: object) {
  const root = await mkdtemp(join(tmpdir(), 'real-repair-guard-'))
  const controlPath = join(root, 'control.json'); const logPath = join(root, 'log.jsonl')
  await writeFile(controlPath, JSON.stringify(value), { mode: 0o600 }); await chmod(controlPath, 0o600)
  return { root, controlPath, logPath }
}

describe('real repair guard', () => {
  test('requires a private, exact bootstrap control and limits files to the artifact', async () => {
    const item = await fixture({ phase: 'bootstrap', ownerSessionId: 'owner', allowedOwnerTools: ['read', 'write', 'goal_create'], artifactPath: 'repair.mjs', maxModelCalls: 2, maxToolCalls: 3 })
    try {
      const control = readControl(item.controlPath, item.root)
      expect(toolAllowed(control, 'owner', 'read', { file_path: '.' }, item.root)).toBe(true)
      expect(toolAllowed(control, 'owner', 'write', { file_path: 'repair.mjs', content: 'x' }, item.root)).toBe(true)
      expect(toolAllowed(control, 'owner', 'write', { file_path: 'other.mjs', content: 'x' }, item.root)).toBe(false)
      expect(toolAllowed(control, 'owner', 'write', { file_path: 'repair.mjs', content: 'x', sandbox_permissions: 'require_escalated' }, item.root)).toBe(false)
      await chmod(item.controlPath, 0o644)
      expect(() => readControl(item.controlPath, item.root)).toThrow('mode 0600')
    } finally { await rm(item.root, { recursive: true, force: true }) }
  })

  test('accepts an empty bootstrap tool set while reserving bootstrap-pending from model dispatch', async () => {
    const item = await fixture({ phase: 'bootstrap', ownerSessionId: 'bootstrap-pending', allowedOwnerTools: [], artifactPath: 'repair.mjs' })
    try {
      const control = readControl(item.controlPath, item.root)
      expect(control.allowedOwnerTools).toEqual([])
      expect(toolAllowed(control, 'bootstrap-pending', 'read', { file_path: 'repair.mjs' }, item.root)).toBe(false)
    } finally { await rm(item.root, { recursive: true, force: true }) }
  })

  test('repair requires one exact owner arm, then permits only read-only owner tools and bounded repair files', async () => {
    const arm = { goal_id: 'failed-goal', profile_id: 'repair', owner_route_id: 'route', invocation_id: 'once', expires_at: 123 }
    const item = await fixture({ phase: 'repair', ownerSessionId: 'owner', repairSessionId: 'repair', ownerArm: { name: 'skill_repair_arm', arguments: arm }, artifactPath: 'repair.mjs' })
    try {
      const control = readControl(item.controlPath, item.root)
      expect(toolAllowed(control, 'owner', 'skill_repair_arm', arm, item.root)).toBe(true)
      expect(toolAllowed(control, 'owner', 'skill_repair_arm', { ...arm, invocation_id: 'twice' }, item.root)).toBe(false)
      expect(toolAllowed(control, 'owner', 'skill_repair_arm', arm, item.root, 1)).toBe(false)
      expect(toolAllowed(control, 'owner', 'read', { file_path: 'repair.mjs' }, item.root, 1)).toBe(true)
      expect(toolAllowed(control, 'owner', 'read', { file_path: '.' }, item.root, 1)).toBe(false)
      expect(toolAllowed(control, 'owner', 'skill_repair_status', { repair_id: 'x' }, item.root, 1)).toBe(true)
      expect(toolAllowed(control, 'repair', 'edit', { file_path: 'repair.mjs', old_string: 'old', new_string: 'new' }, item.root)).toBe(true)
      expect(toolAllowed(control, 'repair', 'edit', { file_path: '../escape.mjs', old_string: 'old', new_string: 'new' }, item.root)).toBe(false)
    } finally { await rm(item.root, { recursive: true, force: true }) }
  })

  test('permits only listed repair sessions during bootstrap and rejects duplicate or unknown session ids', async () => {
    const item = await fixture({ phase: 'bootstrap', ownerSessionId: 'owner', repairSessionIds: ['repair-1', 'repair-2'], allowedOwnerTools: ['read'], artifactPath: 'repair.mjs' })
    try {
      const control = readControl(item.controlPath, item.root)
      expect(toolAllowed(control, 'repair-2', 'write', { file_path: 'repair.mjs', content: 'x' }, item.root)).toBe(true)
      expect(toolAllowed(control, 'repair-3', 'write', { file_path: 'repair.mjs', content: 'x' }, item.root)).toBe(false)
      expect(toolAllowed(control, 'owner', 'write', { file_path: 'repair.mjs', content: 'x' }, item.root)).toBe(false)
      await writeFile(item.controlPath, JSON.stringify({ phase: 'bootstrap', ownerSessionId: 'owner', repairSessionIds: ['repair-2', 'repair-2'], allowedOwnerTools: [], artifactPath: 'repair.mjs' }), { mode: 0o600 })
      expect(() => readControl(item.controlPath, item.root)).toThrow('repair sessions')
    } finally { await rm(item.root, { recursive: true, force: true }) }
  })

  test('restores per-session model and tool budgets from the durable log', async () => {
    const item = await fixture({ phase: 'repair', ownerSessionId: 'owner', repairSessionId: 'repair', ownerArm: { name: 'skill_repair_arm', arguments: {} }, artifactPath: 'repair.mjs' })
    try {
      await writeFile(item.logPath, '{"event":"dispatch","sessionId":"owner"}\n{"event":"tool-execute","sessionId":"repair","name":"edit"}\n{"event":"tool-execute","sessionId":"owner","name":"skill_repair_arm"}\n', { mode: 0o600 })
      await chmod(item.logPath, 0o600)
      const state = logState(item.logPath)
      expect(state.modelCalls.get('owner')).toBe(1)
      expect(state.toolCalls.get('repair')).toBe(1)
      expect(state.ownerArms.get('owner')).toBe(1)
      expect(state.bootstrapSaves.get('owner')).toBeUndefined()
    } finally { await rm(item.root, { recursive: true, force: true }) }
  })

  test('rejects unknown sessions, model drift, and an exhausted persisted model budget before dispatch', async () => {
    const records: unknown[] = []; const state = { modelCalls: new Map([['owner', 1]]), toolCalls: new Map(), ownerArms: new Map() }
    const control = () => ({ phase: 'bootstrap' as const, ownerSessionId: 'owner', allowedOwnerTools: ['read'], artifactPath: 'repair.mjs', maxModelCalls: 1, maxToolCalls: 1 })
    const agent = { session: { id: 'owner' }, cancel: vi.fn() }
    const guard = createRunGuard({ record: (row: unknown) => records.push(row), control, state, provider: 'relay', model: 'm1', sessionForAgent: (value: typeof agent | undefined) => value?.session.id })
    try {
      await expect(guard.stream({ provider: 'relay', model: 'm1' }, agent, vi.fn()).next()).rejects.toThrow('model request rejected')
      await expect(guard.stream({ provider: 'wrong', model: 'm1' }, { ...agent, session: { id: 'unknown' } }, vi.fn()).next()).rejects.toThrow('model request rejected')
      expect(records).toEqual([])
      expect(agent.cancel).toHaveBeenCalledTimes(2)
    } finally { guard.stop() }
  })

  test('keeps model admission live after apply and stops it when the owning Fiber disposes', async () => {
    const item = await fixture({ phase: 'bootstrap', ownerSessionId: 'owner', allowedOwnerTools: [], artifactPath: 'render.mjs' })
    const handlers = new Map<string, Function>(); const disposers: Function[] = []
    const agent = { session: { id: 'owner' }, cancel: vi.fn() }
    const ctx = {
      on: (event: string, handler: Function) => { handlers.set(event, handler) },
      effect: (setup: Function) => { disposers.push(setup()) },
      agents: { currentInitiator: () => agent },
    }
    const next = vi.fn(async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })
    try {
      apply(ctx, { controlPath: item.controlPath, logPath: item.logPath, workspace: item.root, provider: 'relay', model: 'm1' })
      const stream = handlers.get('llm/stream')!({ provider: 'relay', model: 'm1' }, next)
      for await (const _chunk of stream) { /* drain */ }
      expect(next).toHaveBeenCalledOnce()
      expect(disposers).toHaveLength(1)
      disposers[0]()
      await expect(handlers.get('llm/stream')!({ provider: 'relay', model: 'm1' }, next).next()).rejects.toThrow('model request rejected')
    } finally { await rm(item.root, { recursive: true, force: true }) }
  })

  test('permits a skill child only while its exact parent skill_run is executing', async () => {
    const item = await fixture({ phase: 'bootstrap', ownerSessionId: 'owner', allowedOwnerTools: ['skill_run'], artifactPath: 'render.mjs' })
    const handlers = new Map<string, Function>(); const agent = { session: { id: 'owner' } }; const token = {}
    const ctx = { on: (event: string, handler: Function) => { handlers.set(event, handler) }, effect: () => {}, agents: { currentInitiator: () => agent } }
    try {
      apply(ctx, { controlPath: item.controlPath, logPath: item.logPath, workspace: item.root, provider: 'relay', model: 'm1' })
      const execute = handlers.get('tools/execute')!
      let nested = 0
      await execute({ agent, rootCallId: 'root-1', callId: 'outer', token, name: 'skill_run', arguments: {} }, async () => {
        await execute({ agent, rootCallId: 'root-1', callId: 'outer:skill:1', parent: token, name: 'write', arguments: { file_path: 'render.mjs', content: 'repair' } }, async () => { nested++ })
      })
      expect(nested).toBe(1)
      await expect(execute({ agent, rootCallId: 'root-1', callId: 'outer:skill:1', parent: token, name: 'write', arguments: { file_path: 'render.mjs', content: 'repair' } }, async () => {})).rejects.toThrow('outside the controlled session authority')
    } finally { await rm(item.root, { recursive: true, force: true }) }
  })

  test('mounted bootstrap guard persists one successful skill_save, removes its schema, and rejects a duplicate', async () => {
    const item = await fixture({ phase: 'bootstrap', ownerSessionId: 'owner', allowedOwnerTools: ['skill_save', 'skill_run'], artifactPath: 'render.mjs' })
    const handlers = new Map<string, Function>(); const agent = { session: { id: 'owner' } }
    const ctx = { on: (event: string, handler: Function) => { handlers.set(event, handler) }, effect: () => {}, agents: { currentInitiator: () => agent } }
    const assembly = { tools: [{ name: 'skill_save' }, { name: 'skill_run' }], sections: [] }
    try {
      apply(ctx, { controlPath: item.controlPath, logPath: item.logPath, workspace: item.root, provider: 'relay', model: 'm1' })
      const assemble = handlers.get('system-prompt/assemble')!, execute = handlers.get('tools/execute')!
      expect((await assemble({}, { agent }, async () => assembly)).tools.map((tool: { name: string }) => tool.name)).toEqual(['skill_save', 'skill_run'])
      await execute({ agent, rootCallId: 'save-1', callId: 'save-1', name: 'skill_save', arguments: {} }, async () => ({ saved: true }))
      expect(logState(item.logPath).bootstrapSaves.get('owner')).toBe(1)
      expect((await assemble({}, { agent }, async () => assembly)).tools.map((tool: { name: string }) => tool.name)).toEqual(['skill_run'])
      await expect(execute({ agent, rootCallId: 'save-2', callId: 'save-2', name: 'skill_save', arguments: {} }, async () => ({ saved: true }))).rejects.toThrow('outside the controlled session authority')
      await execute({ agent, rootCallId: 'run-1', callId: 'run-1', name: 'skill_run', arguments: {} }, async () => ({ running: true }))
    } finally { await rm(item.root, { recursive: true, force: true }) }
  })

  test('derives a prior bootstrap skill_save from durable tool-execute logs after remount', async () => {
    const item = await fixture({ phase: 'bootstrap', ownerSessionId: 'owner', allowedOwnerTools: ['skill_save', 'skill_run'], artifactPath: 'render.mjs' })
    const handlers = new Map<string, Function>(); const agent = { session: { id: 'owner' } }
    const ctx = { on: (event: string, handler: Function) => { handlers.set(event, handler) }, effect: () => {}, agents: { currentInitiator: () => agent } }
    const assembly = { tools: [{ name: 'skill_save' }, { name: 'skill_run' }], sections: [] }
    try {
      await writeFile(item.logPath, '{"event":"tool-execute","phase":"bootstrap","sessionId":"owner","name":"skill_save"}\n', { mode: 0o600 }); await chmod(item.logPath, 0o600)
      apply(ctx, { controlPath: item.controlPath, logPath: item.logPath, workspace: item.root, provider: 'relay', model: 'm1' })
      const assemble = handlers.get('system-prompt/assemble')!, execute = handlers.get('tools/execute')!
      expect((await assemble({}, { agent }, async () => assembly)).tools.map((tool: { name: string }) => tool.name)).toEqual(['skill_run'])
      expect(toolAllowed(readControl(item.controlPath, item.root), 'owner', 'skill_save', {}, item.root, 0, logState(item.logPath).bootstrapSaves.get('owner'))).toBe(false)
      await expect(execute({ agent, rootCallId: 'save-2', callId: 'save-2', name: 'skill_save', arguments: {} }, async () => ({ saved: true }))).rejects.toThrow('outside the controlled session authority')
    } finally { await rm(item.root, { recursive: true, force: true }) }
  })

  test('concludes only successful owner bootstrap save and repair arm setup turns', async () => {
    const bootstrap = await fixture({ phase: 'bootstrap', ownerSessionId: 'owner', allowedOwnerTools: ['skill_save'], artifactPath: 'render.mjs' })
    const repair = await fixture({ phase: 'repair', ownerSessionId: 'owner', repairSessionId: 'repair', ownerArm: { name: 'skill_repair_arm', arguments: { goal_id: 'goal' } }, artifactPath: 'render.mjs' })
    const mounted = async (item: Awaited<ReturnType<typeof fixture>>, agent: { session: { id: string } }) => {
      const handlers = new Map<string, Function>(); const ctx = { on: (event: string, handler: Function) => { handlers.set(event, handler) }, effect: () => {}, agents: { currentInitiator: () => agent } }
      apply(ctx, { controlPath: item.controlPath, logPath: item.logPath, workspace: item.root, provider: 'relay', model: 'm1' })
      return handlers.get('tools/execute')!
    }
    try {
      const owner = { session: { id: 'owner' } }, bootstrapExecute = await mounted(bootstrap, owner), failed = vi.fn(async () => {})
      await expect(bootstrapExecute({ agent: owner, rootCallId: 'failed', callId: 'failed', name: 'skill_save', arguments: {}, concludeTurn: failed }, async () => { throw new Error('save failed') })).rejects.toThrow('save failed')
      expect(failed).not.toHaveBeenCalled()
      const saved = vi.fn(async () => {})
      await bootstrapExecute({ agent: owner, rootCallId: 'save', callId: 'save', name: 'skill_save', arguments: {}, concludeTurn: saved }, async () => ({ isError: false, value: { saved: true } }))
      expect(saved).toHaveBeenCalledOnce()

      const arm = vi.fn(async () => {}), repairFile = vi.fn(async () => {}), repairOwnerExecute = await mounted(repair, owner)
      await repairOwnerExecute({ agent: owner, rootCallId: 'arm', callId: 'arm', name: 'skill_repair_arm', arguments: { goal_id: 'goal' }, concludeTurn: arm }, async () => ({ isError: false, value: { armed: true } }))
      expect(arm).toHaveBeenCalledOnce()
      const repairAgent = { session: { id: 'repair' } }, repairExecute = await mounted(repair, repairAgent)
      await repairExecute({ agent: repairAgent, rootCallId: 'edit', callId: 'edit', name: 'edit', arguments: { file_path: 'render.mjs', old_string: 'old', new_string: 'new' }, concludeTurn: repairFile }, async () => ({ edited: true }))
      expect(repairFile).not.toHaveBeenCalled()
    } finally { await rm(bootstrap.root, { recursive: true, force: true }); await rm(repair.root, { recursive: true, force: true }) }
  })

  test('reprojects successful setup results through the pinned Tools runtime with concludesTurn', async () => {
    const bootstrap = await fixture({ phase: 'bootstrap', ownerSessionId: 'owner', allowedOwnerTools: ['skill_save'], artifactPath: 'render.mjs' })
    const failedBootstrap = await fixture({ phase: 'bootstrap', ownerSessionId: 'owner', allowedOwnerTools: ['skill_save'], artifactPath: 'render.mjs' })
    const repair = await fixture({ phase: 'repair', ownerSessionId: 'owner', repairSessionId: 'repair', ownerArm: { name: 'skill_repair_arm', arguments: {} }, artifactPath: 'render.mjs' })
    const contexts: Context[] = []
    const execute = async (item: Awaited<ReturnType<typeof fixture>>, sessionId: string, name: 'skill_save' | 'skill_repair_arm' | 'edit', fails = false) => {
      const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
      const parameters = name === 'edit' ? { file_path: { type: 'string', required: true }, old_string: { type: 'string', required: true }, new_string: { type: 'string', required: true } } : {}
      const tools = ctx.get('tools')!
      tools.register(defineTool({ name, description: name, parameters, output: { schema: { type: 'object', additionalProperties: true }, render: () => [] }, execute: async () => { if (fails) throw new Error('tool body rejected'); return { name } } }))
      apply(ctx, { controlPath: item.controlPath, logPath: item.logPath, workspace: item.root, provider: 'relay', model: 'm1' })
      const arguments_ = name === 'edit' ? { file_path: 'render.mjs', old_string: 'old', new_string: 'new' } : {}
      return tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`pinned-${name}-${sessionId}`), name, arguments: arguments_, agent: { session: { id: sessionId } } as never })
    }
    try {
      await expect(execute(bootstrap, 'owner', 'skill_save')).resolves.toMatchObject({ isError: false, concludesTurn: true })
      await expect(execute(repair, 'owner', 'skill_repair_arm')).resolves.toMatchObject({ isError: false, concludesTurn: true })
      const file = await execute(repair, 'repair', 'edit')
      expect(file).toMatchObject({ isError: false }); expect(file.concludesTurn).toBeUndefined()
      const failed = await execute(failedBootstrap, 'owner', 'skill_save', true)
      expect(failed).toMatchObject({ isError: true }); expect(failed.concludesTurn).toBeUndefined()
    } finally { await Promise.all(contexts.map(ctx => ctx.fiber.dispose())); await rm(bootstrap.root, { recursive: true, force: true }); await rm(failedBootstrap.root, { recursive: true, force: true }); await rm(repair.root, { recursive: true, force: true }) }
  })
})
