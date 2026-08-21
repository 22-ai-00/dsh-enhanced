import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantAutomationsService } from '../src/service.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function agent(): Agent {
  const id = SessionId(`automation-tool-agent-${Math.random()}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 1, cwd: '/work/alpha', agentPreset: 'primary',
  })
  return {
    id, options: {}, session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    ctx: new Context(), status: 'idle', cancel() {}, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {},
  }
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-tools-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [
      {
        id: 'automation-service', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
        actions: ['history', 'list', 'propose', 'run-dry'], resource: { kind: 'automation', id: '*' },
      },
      {
        id: 'automation-tools', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
        actions: ['execute'], resource: { kind: 'tool', id: 'automation_*' },
      },
      {
        id: 'automation-background', effect: 'allow', subject: { kind: 'background', id: '*' },
        actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] },
      },
    ],
  })
  await ctx.plugin(AssistantAutomationsService, {
    databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false,
  })
  return { ctx, agent: agent() }
}

function call(name: string, arguments_: Record<string, unknown>, current?: Agent) {
  return {
    callId: CallId(`automation-${name}-${Math.random()}`), name,
    ...(current === undefined ? {} : { agent: current }),
    signal: new AbortController().signal, arguments: arguments_,
  }
}

function createArgs() {
  return {
    automation_id: 'auto-review', principal: 'owner:lark:123', idempotency_key: 'tool:create:review',
    name: 'Review', prompt: 'Review safely.', schedule_kind: 'at', at: '2030-01-01T00:00:00.000Z',
    workspace: '/work/alpha', agent_preset: 'primary', provider: 'mock', model: 'model', allowed_tools: [],
    timeout_ms: 60_000, max_output_tokens: 512, max_tool_calls: 0, misfire_kind: 'latest',
    overlap: 'skip', retry_safety: 'never', max_retries: 0,
  }
}

describe('assistant automations rc.8 tools', () => {
  test('registers exactly five bounded automation tools without schedule name collisions', async () => {
    const { ctx } = await harness()
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('automation_')).sort())
      .toEqual(['automation_create', 'automation_history', 'automation_list', 'automation_manage', 'automation_run'])
    expect(ctx.tools.schemas().some(schema => schema.name.startsWith('schedule_'))).toBe(false)
    await ctx.fiber.restart()
  })

  test('create and manage return proposals; list remains read-only and bounded', async () => {
    const fixture = await harness()
    const proposed = await fixture.ctx.tools.execute(call('automation_create', createArgs(), fixture.agent))
    expect(proposed.isError).toBe(false)
    expect(proposed.isError ? undefined : proposed.value).toMatchObject({ status: 'pending', version: 1 })
    expect((await fixture.ctx.tools.execute(call('automation_list', {}, fixture.agent))).value).toEqual({ automations: [] })
    const proposal = proposed.isError ? undefined : proposed.value as { proposalId: string; version: number }
    fixture.ctx.assistantAutomations.decideProposal({
      proposalId: proposal!.proposalId, principal: 'owner:lark:123', expectedVersion: 1,
      decision: 'approved', reason: 'reviewed',
    })
    const listed = await fixture.ctx.tools.execute(call('automation_list', {}, fixture.agent))
    expect(listed.isError ? undefined : listed.value).toEqual({ automations: [{
      id: 'auto-review', name: 'Review', status: 'active', version: 1,
      schedule: { kind: 'at', at: '2030-01-01T00:00:00.000Z' }, nextRunAt: Date.parse('2030-01-01T00:00:00.000Z'),
      allowedToolCount: 0,
    }] })
    const managed = await fixture.ctx.tools.execute(call('automation_manage', {
      automation_id: 'auto-review', operation: 'pause', expected_version: 1,
      principal: 'owner:lark:123', idempotency_key: 'tool:pause:review',
    }, fixture.agent))
    expect(managed.isError ? undefined : managed.value).toMatchObject({ status: 'pending', mutation: { op: 'pause' } })
    await fixture.ctx.fiber.restart()
  })

  test('automation_run uses a deduplicated dry-run occurrence with no tools and returns terminal history', async () => {
    const fixture = await harness()
    const proposed = await fixture.ctx.tools.execute(call('automation_create', createArgs(), fixture.agent))
    const proposal = proposed.isError ? undefined : proposed.value as { proposalId: string }
    fixture.ctx.assistantAutomations.decideProposal({ proposalId: proposal!.proposalId, principal: 'owner:lark:123',
      expectedVersion: 1, decision: 'approved', reason: 'reviewed' })
    const run = await fixture.ctx.tools.execute(call('automation_run', {
      automation_id: 'auto-review', idempotency_key: 'dry:review',
    }, fixture.agent))
    expect(run.isError).toBe(false)
    expect(run.isError ? undefined : run.value).toMatchObject({
      occurrence: { triggerKind: 'manual', dryRun: true },
      run: { status: 'failed' },
    })
    const replay = await fixture.ctx.tools.execute(call('automation_run', {
      automation_id: 'auto-review', idempotency_key: 'dry:review',
    }, fixture.agent))
    expect(replay.isError ? undefined : replay.value).toEqual(run.isError ? undefined : run.value)
    const history = await fixture.ctx.tools.execute(call('automation_history', {
      automation_id: 'auto-review', limit: 5,
    }, fixture.agent))
    expect(history.isError ? undefined : history.value).toMatchObject({
      occurrences: [expect.objectContaining({ dryRun: true })],
      runs: [expect.objectContaining({ status: 'failed' })],
    })
    await fixture.ctx.fiber.restart()
  })

  test('all five tools fail closed without a trusted Agent', async () => {
    const { ctx } = await harness()
    for (const [name, args] of [
      ['automation_list', {}],
      ['automation_history', {}],
      ['automation_create', createArgs()],
      ['automation_manage', { automation_id: 'x', operation: 'pause', expected_version: 1,
        principal: 'owner', idempotency_key: 'x' }],
      ['automation_run', { automation_id: 'x', idempotency_key: 'x' }],
    ] as const) {
      const result = await ctx.tools.execute(call(name, args))
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('missing-agent')
    }
    await ctx.fiber.restart()
  })
})
