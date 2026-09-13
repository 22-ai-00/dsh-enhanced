import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import ToolRuntime, { type ToolExecution } from '@deepseek-ai/dsh-tools'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import IsolationPlugin from '../src/index.ts'
import { AssistantIsolationService, isolationPrincipalDigest } from '../src/service.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(discoveryAllowed = true, legacyPolicy = false, directClassMount = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'isolation-grant-discovery-'))); roots.push(root)
  const stateRoot = join(root, 'state'), workspace = join(root, 'workspace'); await Promise.all([mkdir(stateRoot, { recursive: true, mode: 0o700 }), mkdir(workspace)])
  const ctx = new Context(); await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true, persona: '' }); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  const owners = new Map<Agent, string | undefined>()
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: (agent: Agent) => {
    const principalId = owners.get(agent)
    return principalId === undefined ? undefined : { principalId, principalLineage: { principalRecordId: `record-${principalId}`, principalVersion: 1 }, scope: { workspace, preset: 'primary' } }
  } } as never)
  new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), toolDefaultEffect: 'deny', rules: [
    ...(discoveryAllowed ? [{ id: 'discover', effect: 'allow' as const, actions: ['execute'], resource: { kind: 'tool' as const, id: 'isolation_grants' } }] : []),
    { id: 'run', effect: 'allow', actions: ['execute'], resource: { kind: 'tool', id: 'isolation:offline' } },
  ] })
  if (legacyPolicy) {
    Object.defineProperty(ctx.assistantPolicy, 'contextToolPreauthorizationVersion', { value: undefined })
    const register = ctx.assistantPolicy.registerPreauthorizedTool.bind(ctx.assistantPolicy)
    ctx.assistantPolicy.registerPreauthorizedTool = (...args) => {
      if (args[1].name === 'isolation_grants') throw new Error('legacy Policy: reserved tool')
      return register(...args)
    }
  }
  const now = Date.now()
  const grants = [
    { id: 'offline', revision: 1, principalDigest: isolationPrincipalDigest('owner'), principalRecordId: 'record-owner', principalVersion: 1, workspace, agentPreset: 'primary', expiresAt: now + 60_000, maxRuns: 3, maxTotalDurationMs: 90_000 },
    { id: 'other-owner', revision: 1, principalDigest: isolationPrincipalDigest('other'), principalRecordId: 'record-other', principalVersion: 1, workspace, agentPreset: 'primary', expiresAt: now + 60_000, maxRuns: 3, maxTotalDurationMs: 90_000 },
    { id: 'expired', revision: 1, principalDigest: isolationPrincipalDigest('owner'), principalRecordId: 'record-owner', principalVersion: 1, workspace, agentPreset: 'primary', expiresAt: now - 1, maxRuns: 3, maxTotalDurationMs: 90_000 },
  ]
  const config = { stateRoot, image: `sha256:${'a'.repeat(64)}`, grants }
  const mountedPlugin = directClassMount ? AssistantIsolationService : IsolationPlugin
  const plugin = await ctx.plugin(mountedPlugin, config) as unknown as { dispose(): Promise<void> }
  const handle = await ctx.agents.create({ sessionId: SessionId('grant-discovery'), meta: { cwd: workspace, agentPreset: 'primary' } })
  owners.set(handle.agent, 'owner')
  return { root, stateRoot, workspace, ctx, config, plugin, mountedPlugin, handle, owners }
}

let nextDiscoveryCall = 0
function discoveryExecution(agent: Agent, arguments_: unknown = {}): ToolExecution {
  const callId = ToolCallId(`grant-discovery-${++nextDiscoveryCall}`)
  return { callId, rootCallId: callId, token: Symbol('grant-discovery') as never, name: 'isolation_grants', arguments: arguments_, signal: new AbortController().signal, agent }
}

test('lists only current owner scope grants with remaining boundaries and no authority mutation', async () => {
  const f = await fixture()
  try {
    expect(f.ctx.tools.get('isolation_grants', f.handle.agent)?.description).toContain('read-only')
    expect(f.ctx.tools.get('isolation_grants', f.handle.agent)?.parameters).toEqual({ type: 'object', properties: {} })
    await expect(f.ctx.assistantIsolation.discover(f.handle.agent)).resolves.toEqual([{ id: 'offline', expiresAt: expect.any(Number), remainingRuns: 3, remainingDurationMs: 90_000,
      limits: expect.objectContaining({ maxDurationMs: 60_000, maxInputBytes: expect.any(Number), maxOutputBytes: expect.any(Number), maxArtifactBytes: expect.any(Number), maxFiles: expect.any(Number) }) }])
    const database = new DatabaseSync(join(f.stateRoot, 'ledger.sqlite'))
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM isolation_jobs').get()).toEqual({ count: 0 })
      database.prepare("UPDATE isolation_grants SET revoked=1 WHERE id='offline'").run()
    } finally { database.close() }
    await expect(f.ctx.assistantIsolation.discover(f.handle.agent)).resolves.toEqual([])
  } finally { await f.handle.dispose(); await f.plugin.dispose(); await f.ctx.fiber.dispose() }
})

test('fails closed for missing owner, foreign scope, and denied discovery Policy', async () => {
  const f = await fixture()
  try {
    f.owners.set(f.handle.agent, undefined)
    await expect(f.ctx.assistantIsolation.discover(f.handle.agent)).rejects.toThrow(/authenticated owner/)
    f.owners.set(f.handle.agent, 'other')
    await expect(f.ctx.assistantIsolation.discover(f.handle.agent)).resolves.toEqual([])
    f.owners.set(f.handle.agent, 'owner')
    const foreign = await f.ctx.agents.create({ sessionId: SessionId('foreign-scope'), meta: { cwd: join(f.workspace, 'other'), agentPreset: 'primary' } })
    f.owners.set(foreign.agent, 'owner')
    await expect(f.ctx.assistantIsolation.discover(foreign.agent)).rejects.toThrow(/authenticated owner/)
    await foreign.dispose()
  } finally { await f.handle.dispose(); await f.plugin.dispose(); await f.ctx.fiber.dispose() }
  const denied = await fixture(false)
  try { await expect(denied.ctx.assistantIsolation.discover(denied.handle.agent)).rejects.toThrow(/policy denied/) }
  finally { await denied.handle.dispose(); await denied.plugin.dispose(); await denied.ctx.fiber.dispose() }
})

test('keeps grant discovery available with a Policy predating context preauthorization', async () => {
  const f = await fixture(true, true)
  try {
    expect(f.ctx.tools.get('isolation_grants', f.handle.agent)).toBeDefined()
    expect(f.ctx.tools.get('isolation_run', f.handle.agent)).toBeDefined()
    expect(f.ctx.assistantPolicy.isPreauthorizedTool(discoveryExecution(f.handle.agent))).toBe(false)
    await expect(f.ctx.assistantIsolation.discover(f.handle.agent)).resolves.toHaveLength(1)
  } finally { await f.handle.dispose(); await f.plugin.dispose(); await f.ctx.fiber.dispose() }
})

test.each([false, true])('preauthorizes only a current exact-owner grant discovery and unregisters on unload (direct class mount: %s)', async (directClassMount) => {
  const f = await fixture(true, false, directClassMount)
  try {
    await f.ctx.plugin(ApprovalService, { policy: 'ask' })
    let asks = 0; f.ctx.on('approval/request', async () => { asks++; return 'rejected' })
    f.handle.agent.session.append('turn/start', { turn: 1 })
    f.handle.agent.session.append('approval/policy', { policy: 'ask' })
    const current = discoveryExecution(f.handle.agent)
    expect(f.ctx.assistantIsolation.preauthorizeDiscovery(current)).toBe(true)
    expect(f.ctx.assistantPolicy.isPreauthorizedTool(current)).toBe(true)
    expect((await f.ctx.tools.execute(current)).isError).toBe(false)
    expect(asks).toBe(0)

    const foreign = await f.ctx.agents.create({ sessionId: SessionId('grant-discovery-foreign'), meta: { cwd: join(f.workspace, 'other'), agentPreset: 'primary' } })
    f.owners.set(foreign.agent, 'owner')
    expect(f.ctx.assistantIsolation.preauthorizeDiscovery(discoveryExecution(foreign.agent))).toBe(false)
    await foreign.dispose()

    expect(f.ctx.assistantIsolation.preauthorizeDiscovery(discoveryExecution(f.handle.agent, { ignored: true }))).toBe(false)
    await f.plugin.dispose()
    expect(f.ctx.assistantPolicy.isPreauthorizedTool(discoveryExecution(f.handle.agent))).toBe(false)
    f.plugin = await f.ctx.plugin(f.mountedPlugin, f.config) as unknown as { dispose(): Promise<void> }
    expect(f.ctx.assistantPolicy.isPreauthorizedTool(discoveryExecution(f.handle.agent))).toBe(true)

    const database = new DatabaseSync(join(f.stateRoot, 'ledger.sqlite'))
    try { database.prepare("UPDATE isolation_grants SET revoked=1 WHERE id='offline'").run() } finally { database.close() }
    expect(f.ctx.assistantIsolation.preauthorizeDiscovery(discoveryExecution(f.handle.agent))).toBe(false)

    await f.plugin.dispose()
    expect(f.ctx.assistantPolicy.isPreauthorizedTool(discoveryExecution(f.handle.agent))).toBe(false)
    f.plugin = await f.ctx.plugin(f.mountedPlugin, f.config) as unknown as { dispose(): Promise<void> }
    expect(f.ctx.assistantPolicy.isPreauthorizedTool(discoveryExecution(f.handle.agent))).toBe(false)
  } finally { await f.handle.dispose(); await f.plugin.dispose(); await f.ctx.fiber.dispose() }

  const denied = await fixture(false)
  try { expect(denied.ctx.assistantIsolation.preauthorizeDiscovery(discoveryExecution(denied.handle.agent))).toBe(false) }
  finally { await denied.handle.dispose(); await denied.plugin.dispose(); await denied.ctx.fiber.dispose() }
})
