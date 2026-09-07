import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { setApprovalReviewer } from '../src/approval-reviewer.ts'
import { AssistantPolicyService, type Config } from '../src/service.ts'

const roots: string[] = []

function createAgent(ctx: Context): Agent {
  const id = SessionId(`preauthorized-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
    cwd: '/work/alpha',
    agentPreset: 'primary',
  })
  const owner: Agent = {
    id,
    options: { provider: 'test', model: 'test' },
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: undefined as unknown as Context,
    status: 'idle' as const,
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
  const contextCarrier = owner as unknown as { ctx: Context }
  contextCarrier.ctx = createScope(ctx, owner).ctx
  session.append('turn/start', { turn: 1 })
  session.append('approval/policy', { policy: 'ask' })
  setApprovalReviewer(session, 'user')
  return owner
}

function definition(name: string, execute: () => void): ToolDefinition {
  return defineTool({
    name,
    description: `${name} preauthorization fixture`,
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_arguments, value) => [{ type: 'text', text: value }] },
    async execute() {
      execute()
      return 'executed'
    },
  })
}

async function fixture(policy: Pick<Config, 'rules' | 'toolDefaultEffect' | 'budgets'> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-preauthorized-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    toolDefaultEffect: 'allow',
    rules: [],
    ...policy,
  })
  let asks = 0
  ctx.on('approval/request', async () => {
    asks += 1
    return 'rejected'
  })
  return { ctx, owner: createAgent(ctx), asks: () => asks }
}

async function execute(ctx: Context, owner: Agent, name = 'action_github_commit', signal = new AbortController().signal) {
  return await ctx.tools.execute({
    callId: ToolCallId(`preauthorized-${Math.random()}`),
    name,
    arguments: { command: 'node trusted-task.js' },
    signal,
    agent: owner,
  })
}

function trustedActionsCaller(ctx: Context, name = 'dsh-enhanced-assistant-actions'): Context {
  const plugin = () => {}
  Object.defineProperty(plugin, 'name', { value: name })
  return ctx.plugin(plugin).ctx
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('trusted Host tool preauthorization', () => {
  test('reserves isolation preauthorization to its exact plugin and keeps revoked grants closed', async () => {
    const current = await fixture()
    let executions = 0
    let active = true
    const tool = definition('isolation_run', () => { executions += 1 })
    current.ctx.tools.register(tool)
    expect(() => current.ctx.assistantPolicy.registerPreauthorizedTool(trustedActionsCaller(current.ctx), tool, () => true)).toThrow(/reserved/)
    current.ctx.assistantPolicy.registerPreauthorizedTool(trustedActionsCaller(current.ctx, 'dsh-enhanced-assistant-isolation'), tool, () => active)
    expect((await execute(current.ctx, current.owner, 'isolation_run')).isError).toBe(false)
    expect(current.asks()).toBe(0)
    active = false
    expect((await execute(current.ctx, current.owner, 'isolation_run')).isError).toBe(true)
    expect(current.asks()).toBe(1)
    expect(executions).toBe(1)
    await current.ctx.fiber.restart()
  })

  test.each(['goal_create', 'goal_schedule', 'goal_strategy'])('reserves %s preauthorization to its exact plugin and keeps revoked predicates closed', async name => {
    const current = await fixture()
    let executions = 0
    let active = true
    const tool = definition(name, () => { executions += 1 })
    current.ctx.tools.register(tool)
    expect(() => current.ctx.assistantPolicy.registerPreauthorizedTool(trustedActionsCaller(current.ctx), tool, () => true)).toThrow(/reserved/)
    current.ctx.assistantPolicy.registerPreauthorizedTool(trustedActionsCaller(current.ctx, 'dsh-enhanced-assistant-goals'), tool, () => active)
    expect((await execute(current.ctx, current.owner, name)).isError).toBe(false)
    expect(current.asks()).toBe(0)
    active = false
    expect((await execute(current.ctx, current.owner, name)).isError).toBe(true)
    expect(current.asks()).toBe(1)
    expect(executions).toBe(1)
    await current.ctx.fiber.restart()
  })

  test('executes an exact granted tool without asking, while ungranted calls still ask and fail closed', async () => {
    const current = await fixture()
    let executions = 0
    const trusted = definition('action_github_commit', () => { executions += 1 })
    current.ctx.tools.register(trusted)
    current.ctx.assistantPolicy.registerPreauthorizedTool(
      trustedActionsCaller(current.ctx),
      trusted,
      execution => execution.arguments !== null,
    )

    const granted = await execute(current.ctx, current.owner)
    expect(granted.isError, JSON.stringify(granted)).toBe(false)
    expect(executions).toBe(1)
    expect(current.asks()).toBe(0)

    const ungranted = definition('ungranted_action', () => { executions += 1 })
    current.ctx.tools.register(ungranted)
    const ungrantedResult = await execute(current.ctx, current.owner, 'ungranted_action')
    expect(ungrantedResult.isError, JSON.stringify(ungrantedResult)).toBe(true)
    expect(current.asks()).toBe(1)
    expect(executions).toBe(1)
    await current.ctx.fiber.restart()
  })

  test('does not let a same-name scoped shadow borrow a global definition grant', async () => {
    const current = await fixture()
    let globalExecutions = 0
    let shadowExecutions = 0
    const global = definition('action_github_commit', () => { globalExecutions += 1 })
    const shadow = definition('action_github_commit', () => { shadowExecutions += 1 })
    current.ctx.tools.register(global)
    current.ctx.assistantPolicy.registerPreauthorizedTool(trustedActionsCaller(current.ctx), global, () => true)
    await current.owner.ctx.inject(['tools'], scope => {
      scope.tools.register(shadow)
    })

    expect(current.ctx.tools.get('action_github_commit', current.owner)).toBe(shadow)
    const shadowResult = await execute(current.ctx, current.owner)
    expect(shadowResult.isError, JSON.stringify(shadowResult)).toBe(true)
    expect(current.asks()).toBe(1)
    expect(globalExecutions).toBe(0)
    expect(shadowExecutions).toBe(0)
    await current.ctx.fiber.restart()
  })

  test('removes grants when explicitly unregistered or when their caller scope disposes', async () => {
    const current = await fixture()
    let executions = 0
    const trusted = definition('action_github_commit', () => { executions += 1 })
    current.ctx.tools.register(trusted)
    const remove = current.ctx.assistantPolicy.registerPreauthorizedTool(trustedActionsCaller(current.ctx), trusted, () => true)
    remove()
    const removedResult = await execute(current.ctx, current.owner)
    expect(removedResult.isError, JSON.stringify(removedResult)).toBe(true)
    expect(current.asks()).toBe(1)

    const caller = trustedActionsCaller(current.ctx)
    current.ctx.assistantPolicy.registerPreauthorizedTool(caller, trusted, () => true)
    const restoredResult = await execute(current.ctx, current.owner)
    expect(restoredResult.isError, JSON.stringify(restoredResult)).toBe(false)
    await caller.fiber.restart()
    const disposedResult = await execute(current.ctx, current.owner)
    expect(disposedResult.isError, JSON.stringify(disposedResult)).toBe(true)
    expect(current.asks()).toBe(2)
    expect(executions).toBe(1)
    await current.ctx.fiber.restart()
  })

  test('keeps policy denials monotonic and fails closed for throwing or aborted predicates', async () => {
    const current = await fixture({
      rules: [{ id: 'deny-commit', effect: 'deny', actions: ['execute'], resource: { kind: 'tool', id: 'action_github_commit' } }],
    })
    let executions = 0
    const trusted = definition('action_github_commit', () => { executions += 1 })
    current.ctx.tools.register(trusted)
    current.ctx.assistantPolicy.registerPreauthorizedTool(trustedActionsCaller(current.ctx), trusted, () => true)
    const deniedResult = await execute(current.ctx, current.owner)
    expect(deniedResult.isError, JSON.stringify(deniedResult)).toBe(true)
    expect(current.asks()).toBe(0)
    expect(executions).toBe(0)

    const failed = await fixture()
    const throwing = definition('action_github_commit', () => { executions += 1 })
    failed.ctx.tools.register(throwing)
    failed.ctx.assistantPolicy.registerPreauthorizedTool(
      trustedActionsCaller(failed.ctx),
      throwing,
      () => { throw new Error('grant lookup failed') },
    )
    const failedResult = await execute(failed.ctx, failed.owner)
    expect(failedResult.isError, JSON.stringify(failedResult)).toBe(true)
    expect(failed.asks()).toBe(1)

    const aborted = new AbortController()
    aborted.abort()
    expect(current.ctx.assistantPolicy.isPreauthorizedTool({
      callId: ToolCallId('aborted-preauthorization'),
      rootCallId: ToolCallId('aborted-preauthorization'),
      name: 'action_github_commit',
      arguments: { command: 'node trusted-task.js' },
      signal: aborted.signal,
      agent: current.owner,
      token: Symbol('preauthorized') as never,
    })).toBe(false)
    await current.ctx.fiber.restart()
  })

  test('rejects generic tools and callers outside assistant-actions', async () => {
    const current = await fixture()
    const commit = definition('action_github_commit', () => {})
    const bash = definition('bash', () => {})
    current.ctx.tools.register(commit)
    current.ctx.tools.register(bash)

    expect(() => current.ctx.assistantPolicy.registerPreauthorizedTool(trustedActionsCaller(current.ctx), bash, () => true))
      .toThrow('reserved for assistant-actions action_github_commit')
    expect(() => current.ctx.assistantPolicy.registerPreauthorizedTool(current.ctx, commit, () => true))
      .toThrow('reserved for assistant-actions action_github_commit')
    await current.ctx.fiber.restart()
  })

  test('evaluates without consuming a budget, while stable authorization keys remain idempotent', async () => {
    const current = await fixture({
      rules: [{
        id: 'allow-dispatch',
        effect: 'allow',
        actions: ['dispatch'],
        resource: { kind: 'tool', id: 'isolation:commit' },
        budget: { id: 'dispatches', amount: 1 },
      }],
      budgets: [{ id: 'dispatches', metric: 'dispatches', limit: 1, periodMs: 60_000, scope: 'subject' }],
    })
    const resource = { kind: 'tool' as const, id: 'isolation:commit' }

    expect(current.ctx.assistantPolicy.evaluateAgent(undefined, 'dispatch', resource))
      .toMatchObject({ effect: 'deny', reasonCode: 'missing-agent' })
    expect(current.ctx.assistantPolicy.evaluateAgent(current.owner, 'dispatch', resource).effect).toBe('allow')
    expect(current.ctx.assistantPolicy.evaluateAgent(current.owner, 'dispatch', resource).effect).toBe('allow')
    expect(current.ctx.assistantPolicy.authorizeAgent(current.owner, 'dispatch', resource, { idempotencyKey: 'commit-1' }).effect)
      .toBe('allow')
    expect(current.ctx.assistantPolicy.authorizeAgent(current.owner, 'dispatch', resource, { idempotencyKey: 'commit-1' }).effect)
      .toBe('allow')
    expect(current.ctx.assistantPolicy.authorizeAgent(current.owner, 'dispatch', resource, { idempotencyKey: 'commit-2' }))
      .toMatchObject({ effect: 'deny', reasonCode: 'budget-exhausted' })
    await current.ctx.fiber.restart()
  })
})
