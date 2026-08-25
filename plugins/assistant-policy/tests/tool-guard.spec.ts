import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecution, type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantPolicyService, createPolicyToolGuard } from '../src/service.ts'
import { setApprovalReviewer } from '../src/approval-reviewer.ts'

const temporaryRoots: string[] = []

async function service(rules: NonNullable<ConstructorParameters<typeof AssistantPolicyService>[1]['rules']>) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-guard-'))
  temporaryRoots.push(root)
  const ctx = new Context()
  return {
    ctx,
    service: new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), rules }),
  }
}

async function serviceWithConfig(
  config: Omit<ConstructorParameters<typeof AssistantPolicyService>[1], 'databasePath'>,
) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-guard-config-'))
  temporaryRoots.push(root)
  const ctx = new Context()
  return {
    ctx,
    service: new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), ...config }),
  }
}

function agent(options: { cwd?: string; preset?: string } = {}): Agent {
  const id = SessionId('session-primary')
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.preset === undefined ? {} : { agentPreset: options.preset }),
  })
  const inbox = new Inbox(session, {
    inserted() {},
    discarded() {},
    claimed() {},
  })
  const ctx = new Context()
  return {
    id,
    options: { provider: 'test-provider', model: 'test-model' },
    session,
    inbox,
    status: 'idle',
    ctx,
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
}

function execution(owner?: Agent): ToolExecution {
  return {
    callId: 'call-1' as ToolExecution['callId'],
    rootCallId: 'call-1' as ToolExecution['rootCallId'],
    name: 'bash',
    arguments: { command: 'pwd' },
    ...(owner === undefined ? {} : { agent: owner }),
    signal: new AbortController().signal,
    token: Symbol('tool-execution') as ToolExecutionToken,
  }
}

function appendSandboxMode(owner: Agent, mode: 'workspace-write' | 'danger-full-access'): void {
  const append = owner.session.append as unknown as (type: string, data: unknown) => unknown
  append.call(owner.session, 'sandbox/mode', { mode })
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('DSH rc.8 tool guard', () => {
  test('registers the risk gate before the monotonic guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-risk-gate-'))
    temporaryRoots.push(root)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const executions: string[] = []
    for (const name of ['read', 'future_external_tool']) {
      ctx.tools.register(defineTool({
        name,
        description: `${name} risk fixture`,
        parameters: {},
        output: { schema: { type: 'string' }, render: (_arguments, value) => [{ type: 'text', text: value }] },
        async execute() {
          executions.push(name)
          return name
        },
      }))
    }
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      toolDefaultEffect: 'allow',
      rules: [],
    })
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })

    const read = await ctx.tools.execute({
      callId: CallId('risk-read'),
      name: 'read',
      arguments: { file_path: 'README.md' },
      signal: new AbortController().signal,
      agent: owner,
    })
    const unknown = await ctx.tools.execute({
      callId: CallId('risk-unknown'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })

    expect(read.isError).toBe(false)
    expect(unknown.isError).toBe(true)
    expect(executions).toEqual(['read'])

    owner.session.append('approval/policy', { policy: 'never' })
    setApprovalReviewer(owner.session, 'none')
    const incoherentNever = await ctx.tools.execute({
      callId: CallId('risk-incoherent-never'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })
    expect(incoherentNever.isError).toBe(true)
    expect(executions).toEqual(['read'])

    appendSandboxMode(owner, 'danger-full-access')
    const fullAccess = await ctx.tools.execute({
      callId: CallId('risk-full-access'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })
    expect(fullAccess.isError).toBe(false)
    expect(executions).toEqual(['read', 'future_external_tool'])
    await ctx.fiber.restart()
  })

  test('can allow only unmatched tool executions without weakening other policy decisions', async () => {
    const fixture = await serviceWithConfig({
      toolDefaultEffect: 'allow',
      rules: [{
        id: 'deny-dangerous-tool',
        effect: 'deny',
        actions: ['execute'],
        resource: { kind: 'tool', id: 'dangerous' },
      }],
    })
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })

    expect(fixture.service.authorizeToolExecution(execution(owner))).toMatchObject({
      effect: 'allow',
      reasonCode: 'tool-default-allow',
    })
    expect(fixture.service.authorizeToolExecution({ ...execution(owner), name: 'dangerous' })).toMatchObject({
      effect: 'deny',
      reasonCode: 'rule-deny',
    })
    expect(fixture.service.authorizeAgent(
      owner,
      'read',
      { kind: 'filesystem', id: '/work/alpha/README.md' },
    )).toMatchObject({ effect: 'deny', reasonCode: 'default-deny' })
    expect(fixture.service.authorizeToolExecution(execution())).toMatchObject({
      effect: 'deny',
      reasonCode: 'missing-agent',
    })

    fixture.service.setEmergencyStop({ enabled: true, actor: 'owner', reason: 'incident' })
    expect(fixture.service.authorizeToolExecution(execution(owner))).toMatchObject({
      effect: 'deny',
      reasonCode: 'emergency-stop',
    })
    await fixture.ctx.fiber.restart()
  })

  test('never bypasses an exhausted explicit tool budget in allow-default mode', async () => {
    const fixture = await serviceWithConfig({
      toolDefaultEffect: 'allow',
      rules: [{
        id: 'budget-bash',
        effect: 'allow',
        actions: ['execute'],
        resource: { kind: 'tool', id: 'bash' },
        budget: { id: 'bash-calls', amount: 1 },
      }],
      budgets: [{ id: 'bash-calls', metric: 'calls', limit: 1, periodMs: 60_000, scope: 'subject' }],
    })
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })

    expect(fixture.service.authorizeToolExecution(execution(owner))).toMatchObject({ effect: 'allow' })
    expect(fixture.service.authorizeToolExecution({
      ...execution(owner),
      callId: 'call-2' as ToolExecution['callId'],
    })).toMatchObject({ effect: 'deny', reasonCode: 'budget-exhausted' })
    await fixture.ctx.fiber.restart()
  })

  test('installs into the real rc.8 ToolRuntime and blocks before the tool body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-real-tools-'))
    temporaryRoots.push(root)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    let executions = 0
    ctx.tools.register(defineTool({
      name: 'probe',
      description: 'policy integration probe',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_arguments, value) => [{ type: 'text', text: value }],
      },
      async execute() {
        executions += 1
        return 'executed'
      },
    }))
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [{
        id: 'allow-probe',
        effect: 'allow',
        actions: ['execute'],
        resource: { kind: 'tool', id: 'probe' },
      }],
    })

    const result = await ctx.tools.execute({
      callId: CallId('probe-call'),
      name: 'probe',
      arguments: {},
      signal: new AbortController().signal,
    })

    expect(executions).toBe(0)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('missing-agent') }),
    ])
    await ctx.fiber.restart()
  })

  test('fails closed without an agent, workspace, or preset identity', async () => {
    const fixture = await service([{
      id: 'allow-bash',
      effect: 'allow',
      actions: ['execute'],
      resource: { kind: 'tool', id: 'bash' },
    }])
    const guard = createPolicyToolGuard(fixture.service)

    expect(guard(execution())).toContain('missing-agent')
    expect(guard(execution(agent({ preset: 'primary' })))).toContain('missing-workspace')
    const relative = { session: { header: { cwd: 'relative/workspace', agentPreset: 'primary' } } } as unknown as Agent
    expect(guard(execution(relative))).toContain('missing-workspace')
    expect(guard(execution(agent({ cwd: '/work/alpha' })))).toContain('missing-agent-preset')
    await fixture.ctx.fiber.restart()
  })

  test('derives trusted identity from the rc.8 agent session header', async () => {
    const fixture = await service([{
      id: 'allow-primary-bash',
      effect: 'allow',
      subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['execute'],
      resource: { kind: 'tool', id: 'bash' },
      context: { initiators: ['foreground'] },
    }])
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })
    const guard = createPolicyToolGuard(fixture.service)

    expect(guard(execution(owner))).toBeUndefined()
    expect(fixture.service.queryAudit({ limit: 10 })).toEqual([
      expect.objectContaining({
        actor: 'agent:primary',
        action: 'execute',
        outcome: 'allowed',
        reasonCode: 'rule-allow',
        details: {
          callId: 'call-1',
          rootCallId: 'call-1',
          arguments: { command: '[REDACTED]' },
        },
      }),
    ])
    await fixture.ctx.fiber.restart()
  })

  test('lets a trusted scheduler bind a background initiator for the agent lifetime', async () => {
    const fixture = await service([{
      id: 'allow-foreground-bash',
      effect: 'allow',
      subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['execute'],
      resource: { kind: 'tool', id: 'bash' },
      context: { initiators: ['foreground'] },
    }])
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })
    const guard = createPolicyToolGuard(fixture.service)
    const unbind = fixture.service.bindInitiator(owner, 'background')

    expect(guard(execution(owner))).toContain('default-deny')
    unbind()
    expect(guard(execution(owner))).toBeUndefined()
    await fixture.ctx.fiber.restart()
  })

  test('limits an external shell grant to the exact preset, workspace, and tool', async () => {
    const fixture = await service([{
      id: 'allow-external-standard-bash',
      effect: 'allow',
      subject: { kind: 'agent', id: 'standard', workspace: '/work/assistant' },
      actions: ['execute'],
      resource: { kind: 'tool', id: 'bash' },
      context: { initiators: ['external'] },
    }])
    const owner = agent({ cwd: '/work/assistant', preset: 'standard' })
    const external = fixture.service.bindInitiator(owner, 'external')
    const guard = createPolicyToolGuard(fixture.service)

    expect(guard(execution(owner))).toBeUndefined()
    expect(guard({ ...execution(owner), name: 'future_sensitive_tool' })).toContain('default-deny')
    expect(guard(execution(agent({ cwd: '/work/other', preset: 'standard' })))).toContain('default-deny')
    expect(guard(execution(agent({ cwd: '/work/assistant', preset: 'primary' })))).toContain('default-deny')
    external()
    expect(guard(execution(owner))).toContain('default-deny')
    await fixture.ctx.fiber.restart()
  })

  test('authorizes service operations from the same trusted agent identity and initiator binding', async () => {
    const fixture = await service([{
      id: 'allow-foreground-memory-search',
      effect: 'allow',
      subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['search'],
      resource: { kind: 'memory', id: 'visible' },
      context: { initiators: ['foreground'] },
    }])
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })

    expect(fixture.service.authorizeAgent(owner, 'search', { kind: 'memory', id: 'visible' }).effect)
      .toBe('allow')
    const unbind = fixture.service.bindInitiator(owner, 'background')
    expect(fixture.service.authorizeAgent(owner, 'search', { kind: 'memory', id: 'visible' }))
      .toMatchObject({ effect: 'deny', reasonCode: 'default-deny' })
    unbind()
    await fixture.ctx.fiber.restart()
  })
})
