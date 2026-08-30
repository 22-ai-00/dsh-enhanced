import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
import { registerLlmRouteCapability, type ToolCallMode } from '@dsh-enhanced/llm-route-capabilities'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AutomationRunnerAmbiguousError, type AutomationRunnerInput } from '../src/coordinator.ts'
import {
  AutomationBudgetReplayError,
  DshAutomationRunner,
} from '../src/runner.ts'
import type { AutomationDefinition } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class ToolCallingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly requestedTools: readonly string[] = ['allowed_tool', 'allowed_tool', 'denied_tool']) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      for (const [index, name] of this.requestedTools.entries()) {
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

async function harness(options: {
  allowUnbudgetedExecution?: boolean
  approvalRoute?: {
    bindingId: string
    workspace: string
    agentPreset: string
    principal: string
  }
  backgroundProposal?: boolean
  budgetMetric?: string
  presetTool?: string
  requestedTools?: readonly string[]
  toolCalls?: ToolCallMode
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-runner-'))
  roots.push(root)
  const ctx = new Context()
  const approvalBindings = new WeakMap<Agent, string>()
  const derivedApprovalRoutes: unknown[] = []
  const unbindApprovalRoute = vi.fn()
  const bindAgentApprovalRoute = vi.fn((current: Agent | undefined, input: { bindingId: string }) => {
    const route = options.approvalRoute
    if (current === undefined || route === undefined || input.bindingId !== route.bindingId
      || current.session.header.cwd !== route.workspace
      || current.session.header.agentPreset !== route.agentPreset) {
      throw new Error('assistant-delivery: Agent identity does not match an active owner approval route')
    }
    approvalBindings.set(current, input.bindingId)
    return () => {
      approvalBindings.delete(current)
      unbindApprovalRoute()
    }
  })
  const prepareAgentApproval = vi.fn((current: Agent | undefined, input: { sourceId: string }) => {
    const route = options.approvalRoute
    if (current === undefined || route === undefined || approvalBindings.get(current) !== route.bindingId) {
      throw new Error('assistant-delivery: Agent session has no authenticated active owner approval route')
    }
    const derived = {
      sourceId: input.sourceId, bindingId: route.bindingId,
      workspace: route.workspace, principal: route.principal,
    }
    derivedApprovalRoutes.push(derived)
    return derived
  })
  if (options.approvalRoute !== undefined) {
    ctx.provide('assistantDelivery' as never, { bindAgentApprovalRoute, prepareAgentApproval } as never)
  }
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  const presetResolve = vi.fn(async (id?: string) => ({ id: id ?? 'primary' }))
  const presetMount = vi.fn(async (agentCtx: Agent['ctx'], id?: string) => {
    if (options.presetTool !== undefined) {
      agentCtx.tools.register(defineTool({
        name: options.presetTool,
        description: 'Mounted only through the configured automation preset.',
        parameters: {},
        output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
        async execute() { return {} },
      }))
    }
    return { id: id ?? 'primary' }
  })
  ctx.provide('agentPresets' as never, { resolve: presetResolve, mount: presetMount } as never)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    budgets: [{
      id: 'runner-budget', metric: options.budgetMetric ?? 'automation-runs',
      limit: 10_000, periodMs: 60_000, scope: 'subject',
    }],
    rules: [{
      id: 'background-tool', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: process.cwd() },
      actions: ['execute', 'startup'], resource: { kind: 'tool', id: 'allowed_tool' }, context: { initiators: ['background'] },
    }],
  })
  let startupDecision: string | undefined
  ctx.on('agent/session-start', ({ agent: started }) => {
    started.session.append('approval/policy', { policy: 'never' })
    started.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    const append = started.session.append as unknown as (type: string, data: unknown) => unknown
    append.call(started.session, 'sandbox/mode', { mode: 'danger-full-access' })
    startupDecision = ctx.assistantPolicy.authorizeAgent(started, 'startup', { kind: 'tool', id: 'allowed_tool' }).effect
  })
  let allowedCalls = 0
  let deniedCalls = 0
  ctx.tools.register(defineTool({
    name: 'allowed_tool', description: 'Allowed in the background run.', parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
    async execute(_args, exec) {
      allowedCalls += 1
      if (options.backgroundProposal) {
        prepareAgentApproval(exec.agent, { sourceId: 'dsh-enhanced-assistant-evolution' })
      }
      return {}
    },
  }))
  ctx.tools.register(defineTool({
    name: 'denied_tool', description: 'Never allowed in the background run.', parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
    async execute() { deniedCalls += 1; return {} },
  }))
  const adapter = new ToolCallingAdapter(options.requestedTools)
  ctx.llm.registerAdapter(['mock'], adapter)
  if (options.toolCalls !== undefined) {
    registerLlmRouteCapability(ctx.llm, { provider: 'mock', toolCalls: options.toolCalls })
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  let flushes = 0
  ctx.on('session/flush', () => { flushes += 1 })
  return {
    ctx, adapter, bindAgentApprovalRoute, derivedApprovalRoutes, presetResolve, presetMount, unbindApprovalRoute,
    calls: () => ({ allowedCalls, deniedCalls, flushes, startupDecision }),
    runner: new DshAutomationRunner(ctx, ctx.assistantPolicy, {
      allowUnbudgetedExecution: options.allowUnbudgetedExecution ?? true,
    }),
  }
}

describe('fresh rc.8 automation Agent runner', () => {
  test('pins identity/model, enforces visibility plus monotonic call cap, flushes, and disposes', async () => {
    const fixture = await harness()
    const result = await fixture.runner.run(input())
    expect(result).toEqual({
      outcome: 'succeeded', sessionId: 'automation-occ-runner-1', output: 'final answer',
      usage: { inputTokens: 30, outputTokens: 8, cacheReadTokens: 2, toolCalls: 1 },
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

  test('resolves and mounts the automation preset before validating its scoped tool plane', async () => {
    const fixture = await harness({ presetTool: 'preset_only', requestedTools: ['preset_only'] })
    const result = await fixture.runner.run(input(definition({ allowedTools: ['preset_only'] })))

    expect(result.outcome).toBe('succeeded')
    expect(fixture.presetResolve).toHaveBeenCalledWith('primary')
    expect(fixture.presetMount).toHaveBeenCalledWith(expect.anything(), 'primary')
    expect(fixture.adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['preset_only'])
    await fixture.ctx.fiber.restart()
  })

  test('binds an immutable background approval route before tools run and disposes it with the Agent', async () => {
    const fixture = await harness({
      approvalRoute: {
        bindingId: 'binding-owner', workspace: process.cwd(), agentPreset: 'primary', principal: 'lark/main/tenant/owner',
      },
      backgroundProposal: true,
      requestedTools: ['allowed_tool'],
    })
    const result = await fixture.runner.run(input(definition({ deliveryBindingId: 'binding-owner' })))

    expect(result.outcome).toBe('succeeded')
    expect(fixture.bindAgentApprovalRoute).toHaveBeenCalledWith(expect.anything(), { bindingId: 'binding-owner' })
    expect(fixture.derivedApprovalRoutes).toEqual([{
      sourceId: 'dsh-enhanced-assistant-evolution', bindingId: 'binding-owner',
      workspace: process.cwd(), principal: 'lark/main/tenant/owner',
    }])
    expect(fixture.unbindApprovalRoute).toHaveBeenCalledOnce()
    await fixture.ctx.fiber.restart()
  })

  test('rejects a background approval route identity mismatch before followup or provider execution', async () => {
    const fixture = await harness({
      approvalRoute: {
        bindingId: 'binding-owner', workspace: '/work/other', agentPreset: 'primary', principal: 'lark/main/tenant/owner',
      },
    })
    await expect(fixture.runner.run(input(definition({ deliveryBindingId: 'binding-owner' }))))
      .rejects.toThrow(/approval route|identity.*match/i)
    expect(fixture.adapter.requests).toHaveLength(0)
    await fixture.ctx.fiber.restart()
  })

  test('passes the immutable tool allowlist to the selected provider without route-specific admission metadata', async () => {
    const fixture = await harness()

    await expect(fixture.runner.run(input(definition())))
      .resolves.toMatchObject({ outcome: 'succeeded' })
    // Two requests: the tool-bearing round plus its followup, which is only
    // reachable once the route is admitted at all.
    expect(fixture.adapter.requests).toHaveLength(2)
    await fixture.ctx.fiber.restart()
  })

  test.each(['native', 'bridge'] as const)(
    'passes a tool-bearing run through an adapter declaring the %s protocol projection',
    async (toolCalls) => {
      const fixture = await harness({ toolCalls })

      await expect(fixture.runner.run(input(definition())))
        .resolves.toMatchObject({ outcome: 'succeeded' })
      expect(fixture.adapter.requests).toHaveLength(2)
      await fixture.ctx.fiber.restart()
    },
  )

  test('fails closed before provider execution when the adapter explicitly declares no tool-call protocol', async () => {
    const fixture = await harness({ toolCalls: 'none' })

    await expect(fixture.runner.run(input(definition())))
      .rejects.toThrow(/adapter mock\/runner-model.*no DSH tool-call protocol/i)
    expect(fixture.adapter.requests).toHaveLength(0)
    await fixture.ctx.fiber.restart()
  })

  test('allows an explicit none declaration when the immutable final tool scope is empty', async () => {
    const fixture = await harness({ requestedTools: [], toolCalls: 'none' })
    const result = await fixture.runner.run(input(definition({ allowedTools: [] })))

    expect(result.outcome).toBe('succeeded')
    expect(fixture.adapter.requests).toHaveLength(1)
    expect(fixture.adapter.requests[0]?.tools ?? []).toEqual([])
    await fixture.ctx.fiber.restart()
  })

  test('requires a budget by default before creating an Agent', async () => {
    const fixture = await harness({ allowUnbudgetedExecution: false })
    await expect(fixture.runner.run(input())).rejects.toThrow(/budget.*required|required.*budget/i)
    expect(fixture.adapter.requests).toHaveLength(0)
    expect(fixture.ctx.agents.list()).toEqual([])
    await fixture.ctx.fiber.restart()
  })

  test('releases only a reservation that fails before Agent submission', async () => {
    const fixture = await harness()
    const release = vi.spyOn(fixture.ctx.assistantPolicy, 'release')
    const finalize = vi.spyOn(fixture.ctx.assistantPolicy, 'finalize')
    vi.spyOn(fixture.ctx.tools, 'schemas').mockImplementationOnce(() => {
      throw new Error('pre-submit schema failure')
    })

    await expect(fixture.runner.run(input(definition({ budgetId: 'runner-budget', budgetAmount: 100 }))))
      .rejects.toThrow(/pre-submit schema failure/)
    expect(release).toHaveBeenCalledOnce()
    expect(finalize).not.toHaveBeenCalled()
    expect(fixture.adapter.requests).toHaveLength(0)
    await fixture.ctx.fiber.restart()
  })

  test('binds budget idempotency to automation, occurrence, and budget and never re-executes a terminal reservation', async () => {
    const fixture = await harness()
    const reserve = vi.spyOn(fixture.ctx.assistantPolicy, 'reserve')
    const value = definition({ budgetId: 'runner-budget', budgetAmount: 100 })
    await fixture.runner.run(input(value))
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({
      budgetId: 'runner-budget',
      idempotencyKey: 'automation-budget:auto-runner:occ-runner:automation-runs:runner-budget',
    }))

    const replay = fixture.runner.run(input(value))
    await expect(replay).rejects.toBeInstanceOf(AutomationBudgetReplayError)
    expect(fixture.adapter.requests).toHaveLength(2)
    await fixture.ctx.fiber.restart()
  })

  test('finalizes the fixed full per-run cost and treats token usage only as execution evidence', async () => {
    class OverBudgetAdapter extends LlmAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'expensive' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'expensive' } }
        yield { type: 'usage', usage: {
          inputTokens: 9, outputTokens: 9, cacheReadTokens: 1, cacheWriteTokens: 1, reasoningTokens: 1,
        } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const fixture = await harness({ requestedTools: [] })
    fixture.ctx.llm.registerAdapter(['over-budget'], new OverBudgetAdapter())
    const finalize = vi.spyOn(fixture.ctx.assistantPolicy, 'finalize')
    const release = vi.spyOn(fixture.ctx.assistantPolicy, 'release')

    const running = fixture.runner.run(input(definition({
      provider: 'over-budget', allowedTools: [], budgetId: 'runner-budget', budgetAmount: 1,
    })))
    await expect(running).resolves.toMatchObject({ outcome: 'succeeded', usage: {
      inputTokens: 9, outputTokens: 9, cacheReadTokens: 1, cacheWriteTokens: 1, reasoningTokens: 1,
      toolCalls: 0,
    } })
    expect(finalize).toHaveBeenCalledWith(expect.any(String), 1)
    expect(release).not.toHaveBeenCalled()
    await fixture.ctx.fiber.restart()
  })

  test('rejects an incompatible Policy budget metric before reservation or Agent creation', async () => {
    const fixture = await harness({ budgetMetric: 'tokens' })
    const reserve = vi.spyOn(fixture.ctx.assistantPolicy, 'reserve')

    await expect(fixture.runner.run(input(definition({ budgetId: 'runner-budget', budgetAmount: 1 }))))
      .rejects.toThrow(/automation-runs.*tokens|tokens.*automation-runs/i)
    expect(reserve).not.toHaveBeenCalled()
    expect(fixture.adapter.requests).toHaveLength(0)
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
