import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import IsolationPlugin from '../src/index.ts'
import { isolationPrincipalDigest } from '../src/service.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

function nativeTool(name: string) {
  return defineTool({ name, description: `${name} fixture tool`, parameters: {},
    output: { schema: { type: 'object' as const, additionalProperties: false, properties: {} }, render: () => [] },
    async execute() { return {} },
  })
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'isolation-scoped-presentation-')); roots.push(root)
  const stateRoot = join(root, 'state'), workspace = join(root, 'workspace'), ordinaryWorkspace = join(root, 'ordinary')
  await Promise.all([mkdir(stateRoot, { recursive: true, mode: 0o700 }), mkdir(workspace), mkdir(ordinaryWorkspace)])
  const ctx = new Context(); await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' }); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  for (const name of ['glob', 'bash', 'read', 'goal_create', 'goal_context', 'goal_checkpoint', 'goal_control']) ctx.tools.register(nativeTool(name))
  ctx.systemPrompt.section({ name: 'tools:glob', order: 1000, text: 'glob instructions' })
  ctx.systemPrompt.section({ name: 'tools:goal_create', order: 1001, text: 'goal create instructions' })
  const owners = new Map<Agent, string | undefined>()
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: (agent: Agent) => {
    const principalId = owners.get(agent)
    return principalId === undefined ? undefined : { principalId, principalLineage: { principalRecordId: `record-${principalId}`, principalVersion: 1 }, scope: { workspace, preset: 'primary' } }
  } } as never)
  new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), toolDefaultEffect: 'deny' })
  const now = Date.now()
  const plugin = await ctx.plugin(IsolationPlugin, { stateRoot, image: `sha256:${'a'.repeat(64)}`, grants: [{
    id: 'offline', revision: 1, principalDigest: isolationPrincipalDigest('owner'), principalRecordId: 'record-owner', principalVersion: 1,
    workspace, agentPreset: 'primary', expiresAt: now + 60_000, maxRuns: 2, maxTotalDurationMs: 60_000,
  }] }) as unknown as { dispose(): Promise<void> }
  const target = await ctx.agents.create({ sessionId: SessionId('isolated-owner'), meta: { cwd: workspace, agentPreset: 'primary' } })
  const ordinary = await ctx.agents.create({ sessionId: SessionId('ordinary'), meta: { cwd: ordinaryWorkspace, agentPreset: 'primary' } })
  owners.set(target.agent, 'owner')
  return { root, stateRoot, ctx, plugin, target, ordinary }
}

const names = (assembly: Awaited<ReturnType<SystemPrompt['assemble']>>) => assembly.tools.map(tool => tool.name)
const assemble = (ctx: Context, agent: Agent) => ctx.systemPrompt.assemble({ agent, scope: agent })

test('presents only the execution-guard surface and fresh-scratch facts to the exact configured owner scope', async () => {
  const f = await fixture()
  try {
    const restricted = await assemble(f.ctx, f.target.agent)
    expect(names(restricted)).toEqual(['goal_checkpoint', 'goal_context', 'goal_create', 'isolation_grants', 'isolation_run'])
    expect(names(restricted)).not.toContain('goal_control')
    expect(restricted.sections.some(section => section.name === 'tools:glob')).toBe(false)
    expect(restricted.sections.some(section => section.name === 'tools:goal_create')).toBe(true)
    const capability = restricted.sections.find(section => section.name === 'assistant-isolation:restricted-scope')?.text
    expect(capability).toContain('fresh scratch workspace')
    expect(capability).toContain('inline files')
    expect(capability).toContain('no Host project mount and no network')
    expect(capability).toContain('do not look for a Host project')

    const ordinary = await assemble(f.ctx, f.ordinary.agent)
    expect(names(ordinary)).toEqual(expect.arrayContaining(['glob', 'bash', 'read', 'goal_control']))
    expect(ordinary.sections.some(section => section.name === 'assistant-isolation:restricted-scope')).toBe(false)
  } finally { await f.target.dispose(); await f.ordinary.dispose(); await f.plugin.dispose(); await f.ctx.fiber.dispose() }
})

test('keeps the configured owner scope hidden after grant revocation and restores the normal surface on unload', async () => {
  const f = await fixture()
  try {
    const database = new DatabaseSync(join(f.stateRoot, 'ledger.sqlite'))
    try { database.prepare("UPDATE isolation_grants SET revoked=1 WHERE id='offline'").run() } finally { database.close() }
    expect(names(await assemble(f.ctx, f.target.agent))).not.toEqual(expect.arrayContaining(['glob', 'bash', 'read', 'goal_control']))
    await f.plugin.dispose()
    const restored = await assemble(f.ctx, f.target.agent)
    expect(names(restored)).toEqual(expect.arrayContaining(['glob', 'bash', 'read', 'goal_control']))
    expect(restored.sections.some(section => section.name === 'assistant-isolation:restricted-scope')).toBe(false)
    expect(restored.sections.some(section => section.name === 'tools:glob')).toBe(true)
  } finally { await f.target.dispose(); await f.ordinary.dispose(); await f.ctx.fiber.dispose() }
})
