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

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('DSH rc.8 tool guard', () => {
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
