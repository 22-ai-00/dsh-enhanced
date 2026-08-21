import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AutomationRunnerAmbiguousError, type AutomationRunnerInput } from '../src/coordinator.ts'
import { DshAutomationRunner } from '../src/runner.ts'
import type { AutomationDefinition } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class ToolCallingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      for (const [index, name] of ['allowed_tool', 'allowed_tool', 'denied_tool'].entries()) {
        const id = CallId(`call-${index}`)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name, argumentsDelta: '{}' }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: '{}' } }
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'final answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'final answer' } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function definition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    name: 'Runner', prompt: 'Use the allowed tool once.',
    schedule: { kind: 'at', at: '2030-01-01T00:00:00.000Z' },
    workspace: process.cwd(), agentPreset: 'primary', provider: 'mock', model: 'runner-model',
    allowedTools: ['allowed_tool'], timeoutMs: 60_000, maxOutputTokens: 777, maxToolCalls: 1,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: 'never', maxRetries: 0,
    principal: 'owner:test', ...overrides,
  }
}

function input(value: AutomationDefinition = definition(), signal = new AbortController().signal): AutomationRunnerInput {
  return {
    automation: { id: 'auto-runner', definition: value, status: 'active', nextRunAt: undefined,
      createdAt: 1, updatedAt: 1, version: 1 },
    occurrence: { id: 'occ-runner', automationId: 'auto-runner', triggerKind: 'manual', triggerKey: 'test',
      scheduledAt: 1, status: 'pending', dryRun: false, createdAt: 1, updatedAt: 1 },
    task: { id: 'task-runner', occurrenceId: 'occ-runner', automationId: 'auto-runner', status: 'running',
      cancelRequested: false, attemptCount: 1, createdAt: 1, updatedAt: 1 },
    sessionId: 'automation-occ-runner-1', signal,
  }
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-runner-'))
  roots.push(root)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [{
      id: 'background-tool', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: process.cwd() },
      actions: ['execute', 'startup'], resource: { kind: 'tool', id: 'allowed_tool' }, context: { initiators: ['background'] },
    }],
  })
  let startupDecision: string | undefined
  ctx.on('agent/session-start', ({ agent: started }) => {
    startupDecision = ctx.assistantPolicy.authorizeAgent(started, 'startup', { kind: 'tool', id: 'allowed_tool' }).effect
  })
  let allowedCalls = 0
  let deniedCalls = 0
  ctx.tools.register(defineTool({
    name: 'allowed_tool', description: 'Allowed in the background run.', parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
    async execute() { allowedCalls += 1; return {} },
  }))
  ctx.tools.register(defineTool({
    name: 'denied_tool', description: 'Never allowed in the background run.', parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
    async execute() { deniedCalls += 1; return {} },
  }))
  const adapter = new ToolCallingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  let flushes = 0
  ctx.on('session/flush', () => { flushes += 1 })
  return {
    ctx, adapter,
    calls: () => ({ allowedCalls, deniedCalls, flushes, startupDecision }),
    runner: new DshAutomationRunner(ctx, ctx.assistantPolicy),
  }
}

describe('fresh rc.8 automation Agent runner', () => {
  test('pins identity/model, enforces visibility plus monotonic call cap, flushes, and disposes', async () => {
    const fixture = await harness()
    const result = await fixture.runner.run(input())
    expect(result).toEqual({
      outcome: 'succeeded', sessionId: 'automation-occ-runner-1', output: 'final answer',
      usage: { inputTokens: 30, outputTokens: 8, cacheReadTokens: 2 },
    })
    expect(fixture.adapter.requests).toHaveLength(2)
    expect(fixture.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'runner-model', maxTokens: 777 })
    expect(fixture.adapter.requests[0]!.tools?.map(tool => tool.name)).toEqual(['allowed_tool'])
    expect(fixture.calls()).toEqual({ allowedCalls: 1, deniedCalls: 0, flushes: 1, startupDecision: 'allow' })
    expect(fixture.ctx.agents.list()).toEqual([])
    await fixture.ctx.fiber.restart()
  })

  test('fails closed for unknown allowlist tools before creating an Agent', async () => {
    const fixture = await harness()
    await expect(fixture.runner.run(input(definition({ allowedTools: ['missing_tool'] })))).rejects.toThrow(/unknown.*missing_tool/i)
    expect(fixture.ctx.agents.list()).toEqual([])
    await fixture.ctx.fiber.restart()
  })

  test('propagates cancellation, commits the interrupted prefix, flushes, and disposes', async () => {
    class BlockingAdapter extends LlmAdapter {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (options.signal === undefined) throw new Error('runner request must carry cancellation')
        await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
      }
    }
    const fixture = await harness()
    fixture.ctx.llm.registerAdapter(['blocking'], new BlockingAdapter())
    const controller = new AbortController()
    const running = fixture.runner.run(input(definition({ provider: 'blocking' }), controller.signal))
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort('test')
    await expect(running).resolves.toMatchObject({ outcome: 'cancelled', sessionId: 'automation-occ-runner-1' })
    expect(fixture.ctx.agents.list()).toEqual([])
    expect(fixture.calls().flushes).toBe(1)
    await fixture.ctx.fiber.restart()
  })

  test('classifies a durability failure after Agent execution as ambiguous and still disposes', async () => {
    const fixture = await harness()
    fixture.ctx.on('session/flush', () => { throw new Error('storage unavailable') })
    await expect(fixture.runner.run(input())).rejects.toBeInstanceOf(AutomationRunnerAmbiguousError)
    expect(fixture.ctx.agents.list()).toEqual([])
    await fixture.ctx.fiber.restart()
  })
})
