import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId,
  type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { createTaskAcceptanceContract, type TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AcceptanceTaskInput, TaskAcceptanceRegistration } from '../src/acceptance.ts'
import { hostAgentToolSchemaDigest } from '../src/host-agent-execution.ts'
import { HostAutomationExecutorRegistry } from '../src/host-executors.ts'
import { AutomationRunnerFailureError } from '../src/coordinator.ts'
import { AssistantAutomationsService } from '../src/service.ts'
import type { HostAgentAuthorizationFence, HostAgentExecutionContract, HostAgentExecutionResult,
  HostAutomationDefinition, HostAutomationExecutionSpec, HostAutomationExecutorInput, HostAutomationExecutorResult } from '../src/types.ts'

const roots: string[] = []
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  if (failures.length > 0) throw failures[0]
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function* text(textValue = 'Host native result'): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: textValue }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: textValue } }
  yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
async function* toolCalls(names: readonly string[]): AsyncIterable<StreamChunk> {
  for (const [index, name] of names.entries()) {
    const id = ToolCallId(`host-agent-call-${index}`)
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name, argumentsDelta: '{}' }
    yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: '{}' } }
  }
  yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
async function* heldText(request: GenerateOptions, started: ReturnType<typeof gate>, release: ReturnType<typeof gate>): AsyncIterable<StreamChunk> {
  started.resolve()
  await new Promise<void>(resolve => {
    if (request.signal?.aborted) resolve()
    else { request.signal?.addEventListener('abort', () => resolve(), { once: true }); void release.promise.then(resolve) }
  })
  request.signal?.throwIfAborted()
  yield* text()
}
class ScriptAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  script: ((request: GenerateOptions, count: number) => AsyncIterable<StreamChunk>) | undefined
  constructor(public defaultEffort: string | undefined = 'low') { super() }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: ['text'], ...(this.defaultEffort === undefined ? {} : {
      reasoning: { defaultEffort: ReasoningEffortId(this.defaultEffort),
        efforts: ['low', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })) },
    }) }
  }
  override async* stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (this.script) yield* this.script(request, this.requests.length)
    else if (this.requests.length === 1) yield* toolCalls(['probe'])
    else yield* text()
  }
}
function hostSuccess(): HostAutomationExecutorResult {
  return { outcome: 'succeeded', failureClass: 'none', failurePhase: 'none', failureCode: 'none',
    sideEffectState: 'none', retryability: 'safe' }
}
function hostResult(native: HostAgentExecutionResult): HostAutomationExecutorResult {
  return native.outcome === 'succeeded' && native.quiescent === true ? hostSuccess() : {
    outcome: 'unknown', failureClass: 'unknown', failurePhase: 'unknown', failureCode: 'native-not-confirmed',
    sideEffectState: 'unknown', retryability: 'unsafe',
  }
}
function rows(path: string, sql: string, ...args: string[]): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare(sql).all(...args) as Array<Record<string, unknown>> } finally { db.close() }
}

async function harness(options: { budget?: 'none' | 'wrong-metric'; retry?: boolean; absentEffort?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'automations-host-agent-')); roots.push(root)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' } })
  const presetMount = vi.fn(() => { throw new Error('Host native execution must not mount a preset') })
  ctx.provide('agentPresets' as never, { resolve: presetMount, mount: presetMount } as never)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    budgets: [{ id: 'host-runs', metric: options.budget === 'wrong-metric' ? 'tokens' : 'automation-runs',
      limit: 100, periodMs: Number.MAX_SAFE_INTEGER, scope: 'subject' }],
    rules: [
      { id: 'host-control', effect: 'allow', subject: { kind: 'background', id: '*' },
        actions: ['execute', 'reconcile', 'run-dry'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
      { id: 'host-intake', effect: 'allow', subject: { kind: 'external', id: 'test-host-intake' },
        actions: ['ingest'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['external'] } },
      { id: 'host-tools', effect: 'allow', subject: { kind: 'agent', id: 'primary', workspace: root },
        actions: ['execute'], resource: { kind: 'tool', id: '*' }, context: { initiators: ['background'] } },
    ],
  })
  const adapter = new ScriptAdapter(options.absentEffort ? undefined : 'low')
  // Passing explicit undefined to a default parameter selects the default.
  if (options.absentEffort) adapter.defaultEffort = undefined
  const provider = ctx.llm.registerAdapter(['mock'], adapter)
  const alternate = new ScriptAdapter('high'); alternate.script = () => text('Ordinary concurrent result')
  ctx.llm.registerAdapter(['alternate'], alternate)
  await ctx.plugin(AgentLoop, { agents: [] })
  const agents: Agent[] = [], startupContexts: unknown[] = [], toolContexts: unknown[] = []
  ctx.on('agent/created', ({ agent }) => {
    agents.push(agent); startupContexts.push(agent.ctx.get('assistantAutomationExecution'))
    agent.session.append('approval/policy', { policy: 'never' })
    agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
    const append = agent.session.append as unknown as (type: string, data: unknown) => unknown
    append.call(agent.session, 'sandbox/mode', { mode: 'danger-full-access' })
  })
  const probe = vi.fn(async (_args: unknown, execution: { agent?: Agent | undefined }) => {
    if (execution.agent === undefined) throw new Error('native fixture requires its real tool execution Agent')
    toolContexts.push(execution.agent.ctx.get('assistantAutomationExecution')); return { observed: true }
  })
  const registerProbe = (description = 'Host native allowed probe') => ctx.tools.register(defineTool({ name: 'probe', description,
    parameters: {}, output: { schema: { type: 'object', additionalProperties: false,
      properties: { observed: { type: 'boolean', required: true } } }, render: () => [] },
    execute: probe,
  }))
  const removeProbe = registerProbe()
  const denied = vi.fn(async () => ({}))
  ctx.tools.register(defineTool({ name: 'denied_probe', description: 'Policy permits this, immutable contract does not.', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] }, execute: denied }))
  const serviceFiber = ctx.plugin(AssistantAutomationsService, { databasePath: join(root, 'automations.sqlite'),
    runsPath: join(root, 'runs'), schedulerEnabled: false, allowUnbudgetedExecution: true })
  await serviceFiber
  const service = ctx.assistantAutomations
  const reserve = vi.spyOn(ctx.assistantPolicy, 'reserve'), finalize = vi.spyOn(ctx.assistantPolicy, 'finalize'), release = vi.spyOn(ctx.assistantPolicy, 'release')
  const automationId = 'host-agent-test', owner = 'test-host-agent'
  const definition: HostAutomationDefinition = { name: 'Bounded native Host executor',
    schedule: { kind: 'at', at: '2099-01-01T00:00:00.000Z' }, workspace: root, agentPreset: 'primary', timeoutMs: 10_000,
    misfire: { kind: 'latest' }, overlap: 'skip', retrySafety: options.retry ? 'idempotent' : 'never', maxRetries: options.retry ? 1 : 0,
    principal: 'owner:host-agent-test', ...(options.budget === 'none' ? {} : { budgetId: 'host-runs', budgetAmount: 1 }),
    execution: { kind: 'host', executorId: 'test-host-agent', executorContractVersion: 1, runbookId: 'bounded-agent/v1', runbookVersion: 1,
      catalogDigest: 'a'.repeat(64), targetScope: { workspace: root, preset: 'primary' }, scopeDigest: '0'.repeat(64),
      ownerRouteId: 'owner/host-agent-test', activationNonce: 'host-agent-activation' },
  }
  const contract = (overrides: Partial<HostAgentExecutionContract> = {}): HostAgentExecutionContract => ({
    provider: 'mock', model: 'script-model', ...(options.absentEffort ? {} : { reasoningEffort: 'low' }), prompt: 'Call probe, then report the result.',
    allowedTools: ['probe'], toolSchemaDigest: hostAgentToolSchemaDigest(ctx.tools.schemas().filter(schema => schema.name === 'probe')),
    maxModelCalls: 2, maxToolCalls: 1, maxOutputTokens: 128, timeoutMs: 5_000, ...overrides,
  })
  const invocations: HostAutomationExecutorInput[] = [], nativeResults: HostAgentExecutionResult[] = [], apiErrors: unknown[] = []
  const callbackAssertions: Error[] = []
  const assertCallbackAssertions = () => { if (callbackAssertions.length > 0) throw callbackAssertions[0] }
  const invoke = async (invocation: HostAutomationExecutorInput, value = contract(), authorization?: HostAgentAuthorizationFence) => {
    try { const result = await service.runAgentForHostExecution(invocation, value, authorization); nativeResults.push(result); return result }
    catch (error) { apiErrors.push(error); throw error }
  }
  let execute = async (invocation: HostAutomationExecutorInput): Promise<HostAutomationExecutorResult> => hostResult(await invoke(invocation))
  let accepts = (spec: HostAutomationExecutionSpec) => spec.runbookId === 'bounded-agent/v1' && spec.runbookVersion === 1
  const unregister = service.registerHostExecutor({ descriptor: { executorId: 'test-host-agent', contractVersion: 1, catalogDigest: 'a'.repeat(64) },
    accepts: spec => accepts(spec),
    async execute(input) {
      invocations.push(input)
      try { return await execute(input) }
      catch (error) {
        // HostRunner correctly contains product executor failures. A test
        // assertion must still escape that containment into the test runner.
        if (error instanceof Error && error.name === 'AssertionError') callbackAssertions.push(error)
        throw error
      }
    },
  })
  service.reconcileSystem({ owner, automationId, idempotencyKey: 'host-agent-seed', definition })
  const activation = service.inspectSystemOwnedActivation({ owner, automationId })!
  const queue = (eventId = 'event-1') => service.ingestExternal({ sourceId: 'test-host-intake', automationId, eventId, occurredAt: Date.now() })
  const drive = async () => {
    try { await service.tick(); await service.whenIdle() } finally { assertCallbackAssertions() }
  }
  const run = async () => { const occurrence = queue(); await drive(); return occurrence }
  const history = () => rows(join(root, 'automations.sqlite'), 'SELECT * FROM automation_runs ORDER BY created_at')
  cleanups.push(async () => { try { unregister(); await ctx.fiber.restart() } finally { assertCallbackAssertions() } })
  return { root, ctx, service, serviceFiber, adapter, alternate, provider, agents, startupContexts, toolContexts, probe, denied,
    presetMount, registerProbe, removeProbe, reserve, finalize, release, automationId, owner, definition, activation,
    contract, invocations, nativeResults, apiErrors, invoke, unregister, queue, drive, run, history,
    execute(value: typeof execute) { execute = value },
    accepts(value: typeof accepts) { accepts = value },
  }
}

describe('authorized Host invocation to one bounded native Agent', () => {
  test('runs the real Host coordinator, registry, native loop and tool with one outer budget', async () => {
    const f = await harness(); const occurrence = await f.run()
    expect(f.nativeResults[0], JSON.stringify({ errors: f.apiErrors.map(String), history: f.history(), invocations: f.invocations.length }))
      .toMatchObject({ outcome: 'succeeded', quiescent: true, output: 'Host native result', contractDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(f.adapter.requests).toHaveLength(2)
    for (const request of f.adapter.requests) expect(request).toMatchObject({ provider: 'mock', model: 'script-model', reasoningEffort: 'low', maxTokens: 128 })
    expect(f.adapter.requests[0]!.tools?.map(tool => tool.name)).toEqual(['probe'])
    expect(f.probe, JSON.stringify(f.agents.flatMap(agent => agent.session.snapshotEvents().filter(event => event.type === 'tool/result'))))
      .toHaveBeenCalledTimes(1)
    expect(f.denied).not.toHaveBeenCalled(); expect(f.presetMount).not.toHaveBeenCalled()
    for (const context of [...f.startupContexts, ...f.toolContexts]) {
      expect(context).toEqual({ mode: 'production', automationId: f.automationId, occurrenceId: occurrence.id })
      expect(Object.isFrozen(context)).toBe(true)
    }
    expect(f.agents[0]!.session.header).toMatchObject({ cwd: f.root, agentPreset: 'primary' })
    expect(f.nativeResults[0]!.sessionId).toBe(String(f.agents[0]!.session.id))
    const receipt = f.agents[0]!.session.snapshotEvents().map(pluginRecordOf).find(record => record?.type === 'plugin:assistant-automations/host-agent-contract')
    expect(receipt?.data).toMatchObject({ protocol: 'assistant-automations/host-agent-contract/v1',
      contractDigest: f.nativeResults[0]!.contractDigest, automationId: f.automationId, occurrenceId: occurrence.id })
    expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).toHaveBeenCalledTimes(1); expect(f.release).not.toHaveBeenCalled()
    expect(f.history()[0]).toMatchObject({ status: 'succeeded', execution_mode: 'production' })
    const objective = JSON.parse(rows(join(f.root, 'automations.sqlite'), "SELECT payload_json FROM automation_evaluation_outbox WHERE observation_kind='terminal'")[0]!.payload_json as string)
    expect(objective).toMatchObject({ executionStatus: 'succeeded', objectiveStatus: 'unknown', evaluator: { version: 'terminal-v1' } })
    expect(rows(join(f.root, 'policy.sqlite'), 'SELECT status, amount, actual_amount FROM budget_reservations'))
      .toEqual([{ status: 'finalized', amount: 1, actual_amount: 1 }])
  })

  test('rejects copies, frozen structural forgeries, and cross-service invocations before creating an Agent', async () => {
    const f = await harness(), other = await harness()
    f.execute(async invocation => {
      for (const copy of [{ ...invocation }, Object.freeze({ ...invocation, targetScope: { ...invocation.targetScope } })]) {
        await expect(f.invoke(copy)).rejects.toThrow()
      }
      await expect(other.service.runAgentForHostExecution(invocation, other.contract())).rejects.toThrow()
      expect(f.agents).toHaveLength(0); expect(other.agents).toHaveLength(0)
      return hostResult(await f.invoke(invocation))
    })
    await f.run()
    expect(f.nativeResults).toHaveLength(1); expect(f.adapter.requests).toHaveLength(2)
    expect(other.adapter.requests).toHaveLength(0)
    await expect(f.invoke(f.invocations[0]!)).rejects.toThrow()
    expect(f.agents).toHaveLength(1)
  })

  test('consumes a real invocation once under concurrent calls', async () => {
    const f = await harness()
    f.execute(async invocation => {
      const results = await Promise.allSettled([f.invoke(invocation), f.invoke(invocation)])
      expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      return hostSuccess()
    })
    await f.run(); expect(f.agents).toHaveLength(1); expect(f.probe).toHaveBeenCalledTimes(1)
    expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).toHaveBeenCalledTimes(1)
  })

  test('consumes a Host invocation once when contract cloning synchronously reenters the API', async () => {
    const f = await harness()
    const create = vi.spyOn(f.ctx.agents, 'create')
    let getterCalls = 0
    let outcomes: PromiseSettledResult<HostAgentExecutionResult>[] = []
    f.execute(async invocation => {
      const valid = f.contract()
      let nested: Promise<HostAgentExecutionResult> | undefined
      const accessorContract = Object.defineProperty({ ...valid }, 'provider', { enumerable: true, configurable: true,
        get() {
          getterCalls += 1
          nested = f.invoke(invocation, valid)
          void nested.catch(() => {})
          return valid.provider
        },
      })
      const outer = f.invoke(invocation, accessorContract)
      outcomes = await Promise.allSettled(nested === undefined ? [outer] : [nested, outer])
      const completed = outcomes.find(result => result.status === 'fulfilled')
      return completed?.status === 'fulfilled' ? hostResult(completed.value) : {
        outcome: 'unknown', failureClass: 'unknown', failurePhase: 'unknown', failureCode: 'reentrant-native-not-confirmed',
        sideEffectState: 'unknown', retryability: 'unsafe',
      }
    })
    await f.run()
    expect(getterCalls).toBe(1)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'rejected'])
    expect(create).toHaveBeenCalledTimes(1)
    expect(f.agents).toHaveLength(1); expect(f.nativeResults).toHaveLength(1)
    expect(f.adapter.requests).toHaveLength(2); expect(f.probe).toHaveBeenCalledTimes(1)
    expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).toHaveBeenCalledTimes(1)
    expect(f.history()[0]?.status).toBe('succeeded')
  })

  test('does not arm a preview invocation', async () => {
    const f = await harness()
    const result = await f.service.runSystemDry({ owner: f.owner, automationId: f.automationId,
      definitionHash: f.activation.definitionHash, idempotencyKey: 'preview-native-denied' })
    expect(f.invocations[0]?.executionMode).toBe('preview')
    expect(result.run.status).not.toBe('succeeded')
    expect(f.apiErrors).toHaveLength(1); expect(f.agents).toHaveLength(0); expect(f.adapter.requests).toHaveLength(0)
  })

  test('does not expose an invocation issuer through the Service or Registry object graph', async () => {
    const f = await harness()
    const queue: Array<{ value: object; depth: number }> = [{ value: f.service, depth: 0 }]
    const seen = new Set<object>()
    while (queue.length > 0) {
      const { value, depth } = queue.shift()!
      if (seen.has(value)) continue
      seen.add(value)
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const prototype = Object.getPrototypeOf(value) as object | null
      const names = new Set([...Reflect.ownKeys(descriptors), ...(prototype ? Reflect.ownKeys(prototype) : [])])
      expect(names.has('runnerKey') && names.has('open')).toBe(false)
      if (depth === 6) continue
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (!/(host|agentOwner|runner|coordinator|delegate|options|dependencies|execution|issuer|key)/iu.test(name)) continue
        if ('value' in descriptor && typeof descriptor.value === 'object' && descriptor.value !== null) {
          queue.push({ value: descriptor.value, depth: depth + 1 })
        }
      }
    }
    const registry = new HostAutomationExecutorRegistry()
    expect(Reflect.ownKeys(registry).map(String)).not.toEqual(expect.arrayContaining(['agentOwner', 'runnerKey', 'agentRunnerKey']))
    await expect(f.service.runAgentForHostExecution(Object.freeze({}) as HostAutomationExecutorInput, f.contract())).rejects.toThrow()
    expect(f.agents).toHaveLength(0)
  })

  test.each(['none', 'wrong-metric'] as const)('refuses native execution under a %s outer budget', async budget => {
    const f = await harness({ budget }); await f.run()
    expect(f.agents).toHaveLength(0); expect(f.adapter.requests).toHaveLength(0)
    expect(f.history()[0]?.status).not.toBe('succeeded')
    expect(f.reserve).not.toHaveBeenCalled()
    if (budget === 'none') expect(f.apiErrors).toHaveLength(1)
  })

  test('cannot reuse a previously reserved occurrence budget', async () => {
    const f = await harness(); const occurrence = f.queue()
    const digest = createHash('sha256').update(JSON.stringify(['assistant-automations-host-budget/v1', f.automationId,
      occurrence.id, f.activation.definitionHash, 'automation-runs', 'host-runs'])).digest('hex')
    const idempotencyKey = `automation-budget:host:v1:${digest}`
    const reserved = f.ctx.assistantPolicy.reserve({ budgetId: 'host-runs', amount: 1,
      subject: { kind: 'background', id: f.automationId, workspace: f.root, principal: f.definition.principal }, idempotencyKey })
    f.reserve.mockClear()
    await f.drive()
    expect(f.agents).toHaveLength(0); expect(f.invocations).toHaveLength(0); expect(f.adapter.requests).toHaveLength(0)
    expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).not.toHaveBeenCalled()
    expect(rows(join(f.root, 'policy.sqlite'), 'SELECT id, status FROM budget_reservations'))
      .toEqual([{ id: reserved.reservationId, status: 'reserved' }])
  })

  test('does not authorize native execution for a retryable Host recovery definition', async () => {
    const f = await harness({ retry: true }); await f.run()
    expect(f.invocations).toHaveLength(1); expect(f.apiErrors).toHaveLength(1)
    expect(f.agents).toHaveLength(0); expect(f.adapter.requests).toHaveLength(0)
  })

  test.each([
    ['maxModelCalls', 0], ['maxToolCalls', -1], ['maxOutputTokens', Number.POSITIVE_INFINITY], ['timeoutMs', Number.NaN],
  ] as const)('rejects non-finite or non-positive %s before creating an Agent', async (field, value) => {
    const f = await harness(); f.execute(async invocation => hostResult(await f.invoke(invocation, f.contract({ [field]: value }))))
    await f.run()
    expect(f.apiErrors).toHaveLength(1); expect(f.agents).toHaveLength(0); expect(f.adapter.requests).toHaveLength(0)
  })

  test('cannot extend the outer Host execution deadline', async () => {
    const f = await harness(); f.execute(async invocation => hostResult(await f.invoke(invocation, f.contract({ timeoutMs: 20_000 }))))
    await f.run(); expect(f.apiErrors).toHaveLength(1); expect(f.agents).toHaveLength(0)
  })

  test('rejects an oversized canonical contract before consuming the invocation or creating its deadline', async () => {
    const f = await harness()
    f.execute(async invocation => {
      const oversized = f.contract({ provider: 'p'.repeat(1_048_577) })
      const timeout = vi.spyOn(globalThis, 'setTimeout')
      try {
        const originalDeadlines = timeout.mock.calls.filter(([, ms]) => ms === oversized.timeoutMs).length
        await expect(f.invoke(invocation, oversized)).rejects.toThrow()
        expect(timeout.mock.calls.filter(([, ms]) => ms === oversized.timeoutMs)).toHaveLength(originalDeadlines)
        expect(f.agents).toHaveLength(0)
      } finally { timeout.mockRestore() }
      return hostResult(await f.invoke(invocation))
    })
    await f.run()
    expect(f.nativeResults[0]?.outcome).toBe('succeeded'); expect(f.agents).toHaveLength(1)
    expect(f.adapter.requests).toHaveLength(2)
    expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).toHaveBeenCalledTimes(1)
  })

  test.each(['missing-provider', 'unsupported-effort', 'absent-effort-with-default', 'route-drift', 'schema-drift'] as const)
  ('rejects %s before a paid model request', async mode => {
    const f = await harness()
    const override = mode === 'missing-provider' ? { provider: 'unavailable' }
      : mode === 'unsupported-effort' ? { reasoningEffort: 'unsupported-effort' } : {}
    if (mode === 'route-drift') f.ctx.on('agent/request', async (_request, next) => ({ ...await next(), provider: 'alternate' }))
    if (mode === 'schema-drift') f.ctx.on('agent/pre-step', async (_input, next) => {
      f.removeProbe(); f.registerProbe('The schema changed after the contract was frozen.'); return await next()
    })
    f.execute(async invocation => {
      const value = f.contract(override)
      if (mode === 'absent-effort-with-default') {
        const { reasoningEffort: _observedAbsent, ...withoutEffort } = value
        return hostResult(await f.invoke(invocation, withoutEffort))
      }
      return hostResult(await f.invoke(invocation, value))
    })
    await f.run()
    expect(f.adapter.requests).toHaveLength(0); expect(f.alternate.requests).toHaveLength(0); expect(f.probe).not.toHaveBeenCalled()
    expect(f.history()[0]?.status).not.toBe('succeeded')
    expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).toHaveBeenCalledTimes(1)
    expect(rows(join(f.root, 'policy.sqlite'), 'SELECT status, actual_amount FROM budget_reservations')).toEqual([{ status: 'finalized', actual_amount: 1 }])
  })

  test('preserves an actually absent reasoning effort', async () => {
    const f = await harness({ absentEffort: true }); await f.run()
    expect(f.nativeResults[0]?.outcome).toBe('succeeded')
    expect(f.adapter.requests.every(request => request.reasoningEffort === undefined)).toBe(true)
  })

  test('refuses a factory Session that differs from the private occurrence Session', async () => {
    const f = await harness(); const create = f.ctx.agents.create.bind(f.ctx.agents)
    vi.spyOn(f.ctx.agents, 'create').mockImplementation(options => create({ ...options, sessionId: SessionId('wrong-factory-session') }))
    await f.run()
    expect(f.apiErrors).toHaveLength(1); expect(f.adapter.requests).toHaveLength(0); expect(f.probe).not.toHaveBeenCalled()
    expect(f.history()[0]?.status).not.toBe('succeeded')
  })

  test('enforces a finite model-call cap on the real native loop', async () => {
    const f = await harness(); f.execute(async invocation => hostResult(await f.invoke(invocation, f.contract({ maxModelCalls: 1 }))))
    await f.run(); expect(f.adapter.requests).toHaveLength(1); expect(f.probe).toHaveBeenCalledTimes(1)
    expect(f.history()[0]?.status).not.toBe('succeeded')
  })

  test('does not dispatch a paid model request after a synchronous native step exceeds its frozen deadline', async () => {
    const f = await harness(); let stalled = false; let stallElapsedMs = 0
    f.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (!stalled && agent.ctx.get('assistantAutomationExecution')?.automationId === f.automationId) {
        stalled = true
        const startedAt = Date.now()
        while (Date.now() - startedAt < 1_100) { /* Synchronously block the real native step beyond its contract. */ }
        stallElapsedMs = Date.now() - startedAt
      }
      return await next()
    })
    f.execute(async invocation => hostResult(await f.invoke(invocation, f.contract({ timeoutMs: 1_000 }))))
    await f.run()
    expect(stalled).toBe(true); expect(stallElapsedMs).toBeGreaterThanOrEqual(1_100)
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.probe).not.toHaveBeenCalled()
  })

  test('enforces tool calls and hidden-tool denial independently of Policy allow', async () => {
    const f = await harness(); f.adapter.script = (_request, count) => count === 1 ? toolCalls(['probe', 'probe', 'denied_probe']) : text()
    await f.run(); expect(f.probe).toHaveBeenCalledTimes(1); expect(f.denied).not.toHaveBeenCalled()
    expect(f.adapter.requests.every(request => request.tools?.every(tool => tool.name === 'probe'))).toBe(true)
  })

  test('does not apply Host strict stream guards to an unrelated concurrent Session', async () => {
    const f = await harness(), started = gate(), release = gate()
    f.adapter.script = async function* (request, count) {
      if (count > 1) { yield* text('Host concurrent result'); return }
      started.resolve()
      await new Promise<void>(resolve => {
        if (request.signal?.aborted) resolve()
        else { request.signal?.addEventListener('abort', () => resolve(), { once: true }); void release.promise.then(resolve) }
      })
      request.signal?.throwIfAborted(); yield* toolCalls(['probe'])
    }
    f.alternate.script = (_request, count) => count === 1 ? toolCalls(['denied_probe']) : text('Ordinary concurrent result')
    const running = f.run()
    let ordinary: AgentHandle | undefined
    let unbindOrdinary: (() => void) | undefined
    try {
      await started.promise
      ordinary = await f.ctx.agents.create({ sessionId: SessionId('ordinary-concurrent'), meta: { cwd: f.root, agentPreset: 'primary' },
        agentOptions: { provider: 'alternate', model: 'script-model' } })
      unbindOrdinary = f.ctx.assistantPolicy.bindInitiator(ordinary.agent, 'background')
      ordinary.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Unrelated ordinary work' }], source: { kind: 'user' } }))
      await ordinary.agent.whenIdle()
      expect(f.alternate.requests).toHaveLength(2); expect(f.denied).toHaveBeenCalledTimes(1)
      release.resolve(); await running
      expect(f.nativeResults[0]).toMatchObject({ outcome: 'succeeded', output: 'Host concurrent result', quiescent: true })
      expect(f.adapter.requests).toHaveLength(2); expect(f.probe).toHaveBeenCalledTimes(1)
    } finally { release.resolve(); await running; unbindOrdinary?.(); await ordinary?.dispose() }
  })

  test.each([['scope', 1], ['nonce', 1], ['scope', 2], ['nonce', 2]] as const)
  ('refuses an impure accepts callback mutating %s on proof %i', async (field, selectedCall) => {
    const f = await harness(); let calls = 0
    f.accepts(spec => {
      if (++calls === selectedCall) {
        if (field === 'scope') spec.targetScope.workspace = '/unowned-workspace'
        else spec.activationNonce = 'mutated-activation'
      }
      return true
    })
    await f.run()
    expect(calls).toBeGreaterThanOrEqual(selectedCall)
    expect(f.agents).toHaveLength(0); expect(f.adapter.requests).toHaveLength(0); expect(f.invocations).toHaveLength(0)
    expect(f.reserve).not.toHaveBeenCalled()
    expect(f.service.inspectSystemOwnedActivation({ owner: f.owner, automationId: f.automationId })).toEqual(f.activation)
    expect(rows(join(f.root, 'policy.sqlite'), 'SELECT status FROM budget_reservations')).toEqual([])
  })

  test.each(['return', 'throw'] as const)('invalidates and drains a native call when its Host executor does not await it (%s)', async completion => {
    const f = await harness(), started = gate(), release = gate()
    f.adapter.script = request => heldText(request, started, release)
    let pending: Promise<HostAgentExecutionResult> | undefined
    f.execute(async invocation => {
      pending = f.invoke(invocation); void pending.catch(() => {})
      await started.promise
      if (completion === 'throw') throw new Error('Host executor failed before awaiting its native child')
      return hostSuccess()
    })
    try {
      await f.run()
      await expect(pending!).rejects.toThrow()
      expect(f.history()[0]?.status).toBe('unknown')
      expect(f.agents.every(agent => f.ctx.agents.get(agent.id) === undefined)).toBe(true)
      expect(f.adapter.requests).toHaveLength(1)
      await expect(f.invoke(f.invocations[0]!)).rejects.toThrow()
      expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).toHaveBeenCalledTimes(1)
    } finally { release.resolve() }
  })

  test.each(['registration', 'task'] as const)('cancels the real native Agent on %s cancellation without reuse', async cancellation => {
    const f = await harness(), started = gate(), release = gate()
    f.adapter.script = request => heldText(request, started, release)
    const occurrence = f.queue(), running = f.drive()
    try {
      await started.promise
      if (cancellation === 'registration') f.unregister()
      else {
        const [task] = rows(join(f.root, 'automations.sqlite'), 'SELECT id FROM automation_tasks WHERE occurrence_id = ?', occurrence.id)
        await f.service.cancel(task!.id as string)
      }
      await running
      expect(f.history()[0]?.status).not.toBe('succeeded')
      await expect(f.invoke(f.invocations[0]!)).rejects.toThrow()
      expect(JSON.parse(f.history()[0]!.diagnostic_json as string)).toMatchObject({ sideEffectState: 'unknown', retryability: 'unsafe' })
      // Coordinator cancellation may commit its terminal before the owned
      // runner disposer settles; capability revocation above is immediate.
      await vi.waitFor(() => expect(f.agents.every(agent => f.ctx.agents.get(agent.id) === undefined)).toBe(true), { timeout: 3_000 })
      expect(f.adapter.requests).toHaveLength(1)
      expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).toHaveBeenCalledTimes(1)
    } finally { release.resolve(); await running }
  })

  test('unloading the Automations provider invalidates its live invocation', async () => {
    const f = await harness(), started = gate(), release = gate()
    f.adapter.script = request => heldText(request, started, release)
    const running = f.run()
    try {
      await started.promise
      await f.serviceFiber.dispose()
      await running
      expect(f.agents.every(agent => f.ctx.agents.get(agent.id) === undefined)).toBe(true)
      expect(f.adapter.requests).toHaveLength(1)
      await expect(f.invoke(f.invocations[0]!)).rejects.toThrow()
    } finally { release.resolve(); await running }
  })

  test('fences a real factory result that arrives after registration unload', async () => {
    const f = await harness(), entered = gate(), release = gate()
    const create = f.ctx.agents.create.bind(f.ctx.agents)
    const creating = vi.spyOn(f.ctx.agents, 'create').mockImplementation(async options => {
      entered.resolve(); await release.promise; return await create(options)
    })
    const running = f.run()
    try {
      await entered.promise
      f.unregister(); await running
      expect(f.history()[0]?.status).toBe('unknown')
      expect(f.adapter.requests).toHaveLength(0)
      release.resolve()
      await Promise.allSettled(creating.mock.results.map(result => result.value as Promise<unknown>))
      expect(f.agents.every(agent => f.ctx.agents.get(agent.id) === undefined)).toBe(true)
      expect(f.adapter.requests).toHaveLength(0)
      await expect(f.invoke(f.invocations[0]!)).rejects.toThrow()
      expect(creating).toHaveBeenCalledTimes(1)
    } finally { release.resolve(); await running }
  })

  test('does not switch suppliers after the selected provider unloads between native steps', async () => {
    const f = await harness(), enteredTool = gate(), release = gate()
    f.probe.mockImplementationOnce(async () => { enteredTool.resolve(); await release.promise; return { observed: true } })
    const running = f.run()
    try {
      await enteredTool.promise
      f.provider(); release.resolve(); await running
      expect(f.adapter.requests).toHaveLength(1); expect(f.alternate.requests).toHaveLength(0)
      expect(f.history()[0]?.status).not.toBe('succeeded')
    } finally { release.resolve(); await running }
  })

  test('bounds a real paid model request by the frozen native deadline', async () => {
    const f = await harness(), started = gate(), release = gate()
    f.adapter.script = request => heldText(request, started, release)
    f.execute(async invocation => hostResult(await f.invoke(invocation, f.contract({ timeoutMs: 3_000 }))))
    const running = f.run()
    try {
      await Promise.race([started.promise, running.then(() => { throw new Error('bounded native request did not start') })])
      await running
      expect(f.adapter.requests).toHaveLength(1); expect(f.history()[0]?.status).not.toBe('succeeded')
      expect(f.agents.every(agent => f.ctx.agents.get(agent.id) === undefined)).toBe(true)
      await expect(f.invoke(f.invocations[0]!)).rejects.toThrow()
    } finally { release.resolve(); await running }
  })

  test('bounds provider output even if the script ignores its requested token cap', async () => {
    const f = await harness(); f.adapter.script = () => text('x'.repeat(1_000))
    f.execute(async invocation => hostResult(await f.invoke(invocation, f.contract({ maxOutputTokens: 4 }))))
    await f.run()
    expect(f.adapter.requests).toHaveLength(1); expect(f.adapter.requests[0]?.maxTokens).toBe(4)
    expect(f.history()[0]?.status).not.toBe('succeeded')
  })

  test('cannot turn an unconfirmed native teardown into succeeded by returning a valid Host result', async () => {
    const f = await harness(), release = gate()
    const create = f.ctx.agents.create.bind(f.ctx.agents)
    const realHandles: AgentHandle[] = []
    vi.spyOn(f.ctx.agents, 'create').mockImplementation(async options => {
      const handle = await create(options); realHandles.push(handle)
      return { agent: handle.agent, async dispose() { await release.promise; await handle.dispose() } }
    })
    f.execute(async invocation => {
      try { await f.invoke(invocation) } catch { /* A faulty Host claims success regardless of its child result. */ }
      return hostSuccess()
    })
    try {
      await f.run()
      expect(f.history()[0]?.status).toBe('unknown')
      expect(f.nativeResults.every(result => result.outcome !== 'succeeded' || result.quiescent !== true)).toBe(true)
      await expect(f.invoke(f.invocations[0]!)).rejects.toThrow()
      expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).toHaveBeenCalledTimes(1)
      expect(rows(join(f.root, 'policy.sqlite'), 'SELECT status, actual_amount FROM budget_reservations')).toEqual([{ status: 'finalized', actual_amount: 1 }])
    } finally { release.resolve(); await Promise.all(realHandles.map(handle => handle.dispose())) }
  })

  test('settles the real outer budget once when the Host executor throws a typed inner failure', async () => {
    const f = await harness()
    f.execute(async () => { throw new AutomationRunnerFailureError('typed Host failure fixture', {
      schemaVersion: 1, failureClass: 'configuration', failurePhase: 'agent-setup', failureCode: 'fixture-inner-failure',
      promptSubmissionState: 'not-submitted', sideEffectState: 'none', retryability: 'after-intervention', budgetSettlementState: 'not-required',
    }) })
    await f.run()
    expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).toHaveBeenCalledTimes(1); expect(f.release).not.toHaveBeenCalled()
    expect(rows(join(f.root, 'policy.sqlite'), 'SELECT status, actual_amount FROM budget_reservations')).toEqual([{ status: 'finalized', actual_amount: 1 }])
    expect(f.agents).toHaveLength(0); expect(f.history()[0]?.status).not.toBe('succeeded')
    expect(JSON.parse(f.history()[0]!.diagnostic_json as string).budgetSettlementState).toBe('finalized')
  })

  test('keeps a missing native turn unknown even when its Host executor returns succeeded', async () => {
    const f = await harness(); const create = f.ctx.agents.create.bind(f.ctx.agents)
    vi.spyOn(f.ctx.agents, 'create').mockImplementation(async options => {
      const handle = await create(options)
      // Fault-inject the existing queue operation, not the new API result:
      // the real native Agent has no terminal turn to attest to afterward.
      vi.spyOn(handle.agent, 'followup').mockImplementation(() => {})
      return handle
    })
    f.execute(async invocation => {
      const result = await f.invoke(invocation)
      expect(result).toMatchObject({ outcome: 'unknown', quiescent: true, sessionId: String(f.agents[0]!.session.id) })
      return hostSuccess()
    })
    await f.run()
    expect(f.nativeResults[0]).toMatchObject({ outcome: 'unknown', quiescent: true })
    expect(f.history()[0]).toMatchObject({ status: 'unknown', session_id: f.nativeResults[0]!.sessionId })
    expect(JSON.parse(f.history()[0]!.diagnostic_json as string)).toMatchObject({ sideEffectState: 'unknown', retryability: 'unsafe', budgetSettlementState: 'finalized' })
    expect(f.adapter.requests).toHaveLength(0); expect(f.finalize).toHaveBeenCalledTimes(1)
  })

  test('does not let a Host executor alter public usage or diagnostics before durable outer settlement', async () => {
    const f = await harness(); let originalUsage: Readonly<Record<string, unknown>> | undefined
    f.execute(async invocation => {
      const result = await f.invoke(invocation)
      originalUsage = structuredClone(result.usage)
      expect(result.diagnostic).toMatchObject({ failureClass: 'none', failureCode: 'none' })
      expect(Object.isFrozen(result.usage)).toBe(true)
      expect(Object.isFrozen(result.diagnostic)).toBe(true)
      expect(result.usage.toolCalls).toBe(f.probe.mock.calls.length)
      expect(result.usage.outputTokens).toBe(f.adapter.requests.length * 3)
      expect(() => { (result.usage as Record<string, unknown>).toolCalls = 999 }).toThrow(TypeError)
      expect(() => { (result.usage as Record<string, unknown>).outputTokens = 999 }).toThrow(TypeError)
      expect(() => { (result.diagnostic as unknown as Record<string, unknown>).failureClass = 'forged' }).toThrow(TypeError)
      return hostSuccess()
    })
    await f.run()
    expect(JSON.parse(f.history()[0]!.usage_json as string)).toEqual(originalUsage)
    expect(JSON.parse(f.history()[0]!.diagnostic_json as string)).toMatchObject({ failureClass: 'none', budgetSettlementState: 'finalized' })
    expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).toHaveBeenCalledTimes(1)
  })
})


describe('required Host Agent acceptance', () => {
  const acceptance = Object.freeze({ required: true as const, objective: 'Summarize the owner-provided records.', sourceDigest: 'c'.repeat(64) })

  function enable(f: Awaited<ReturnType<typeof harness>>, options: { owner?: boolean; profile?: boolean; expired?: boolean } = {}) {
    let generation = 3
    let live = true
    let contract: TaskAcceptanceContract | undefined
    const prepare = vi.fn((input: AcceptanceTaskInput) => {
      if (options.profile === false) return null
      const now = Date.now()
      contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v1', id: 'host-acceptance', ...input,
        profile: { id: 'host-profile', version: 1, digest: 'd'.repeat(64) },
        issuedAt: now - 2_000, expiresAt: options.expired ? now - 1_000 : now + 60_000,
        criteria: [{ id: 'result', kind: 'process-behavior', authority: { id: 'checker', digest: 'e'.repeat(64) },
          artifactPath: 'result.txt', stdin: '', expectedStdout: 'verified', expectedExitCode: 0 }],
        bounds: { maxDurationMs: 5_000, maxEvidenceBytes: 4_096 },
      })
      return { contractId: contract.id, contractDigest: contract.digest }
    })
    const registration: TaskAcceptanceRegistration = {
      protocol: 'assistant-verifier/host-producer/v1', generation: f.service.trustedAcceptanceProducerGeneration(),
      owner: { ownsTaskAcceptanceRegistration: candidate => live && candidate === registration },
      requiresAcceptance: false, prepare, completed: async () => {},
    }
    f.ctx.provide('assistantVerifier' as never, {
      ...registration.owner,
      inspectAcceptedTask: (id: string) => contract?.id === id ? { contract, state: 'awaiting-execution' } : null,
    } as never)
    f.service.registerTaskAcceptanceSink(registration)
    if (options.owner !== false) {
      f.ctx.provide('assistantDelivery' as never, {
        inspectOwnerRouteBinding: (input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => ({
          protocol: 'assistant-delivery/owner-route-binding/v1', bindingId: 'live-host-binding',
          receipt: { ...input, receiptVersion: 2, bindingVersion: 2, generation,
            principalRecordId: 'host-owner-record', principalVersion: 4 },
        }),
      } as never)
    }
    return { prepare, acceptedContract: () => contract!, unloadVerifier: () => { live = false },
      advanceOwnerGeneration: () => { generation += 1 } }
  }

  const invokeRequired = (f: Awaited<ReturnType<typeof harness>>,
    requirement: NonNullable<HostAgentExecutionContract['acceptance']> = acceptance) => {
    const controller = new AbortController()
    f.execute(async invocation => hostResult(await f.invoke(invocation, f.contract({ acceptance: requirement }),
      { signal: controller.signal, assertCurrent: () => {} })))
  }

  test.each([
    { invalid: 'oversized UTF-8', objective: '界'.repeat(2_731) },
    { invalid: 'blank', objective: ' \t\n' },
    { invalid: 'NUL', objective: 'valid prefix\0invalid suffix' },
  ])('rejects an $invalid acceptance objective at the Host boundary', async ({ objective }) => {
    const f = await harness()
    invokeRequired(f, { ...acceptance, objective })
    await f.run()
    expect(f.apiErrors[0]).toMatchObject({ message: 'assistant-automations: invalid Host Agent acceptance requirement' })
    expect(f.adapter.requests).toHaveLength(0)
  })

  test('durably binds the real Host attempt and delegated objective before its first model request', async () => {
    const f = await harness(), { prepare, acceptedContract, advanceOwnerGeneration } = enable(f)
    const path = join(f.root, 'automations.sqlite')
    const duringPrompt: Array<Record<string, unknown>> = []
    f.adapter.script = () => {
      duringPrompt.push(...rows(path, 'SELECT * FROM automation_task_acceptance'))
      return text()
    }
    invokeRequired(f)
    const occurrence = await f.run()
    const terminal = f.service.inspectProductionOccurrence({ automationId: f.automationId, occurrenceId: occurrence.id,
      workspace: f.root, agentPreset: 'primary' })
    expect(terminal).toMatchObject({ status: 'succeeded', quiescent: true, budgetSettlementState: 'finalized' })
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'script-model', reasoningEffort: 'low' })
    expect(prepare).toHaveBeenCalledExactlyOnceWith({
      scope: { workspace: f.root, preset: 'primary' }, owner: { principalRecordId: 'host-owner-record', principalVersion: 4 },
      task: { kind: 'automation-run', ref: `run-${terminal!.taskId}` }, objective: acceptance.objective,
    })
    expect(duringPrompt).toHaveLength(1)
    expect(duringPrompt[0]).toMatchObject({ task_id: terminal!.taskId, submitted: 1, binding_generation: 3 })
    const proof = JSON.parse(duringPrompt[0]!.host_proof_json as string)
    expect(proof).toMatchObject({ occurrenceId: occurrence.id, attemptId: terminal!.attemptId,
      definitionHash: terminal!.immutableContext.definitionHash, activationNonce: f.activation.activationNonce,
      executionContractDigest: f.nativeResults[0]!.contractDigest, sourceDigest: acceptance.sourceDigest })
    const accepted = { ...prepare.mock.calls[0]![0], id: acceptedContract().id, digest: acceptedContract().digest }
    expect(await f.service.inspectAcceptedExecution(accepted)).toMatchObject({
      executionRef: terminal!.runId, status: 'succeeded', quiescent: true,
    })
    const lookup = { automationId: f.automationId, occurrenceId: occurrence.id, workspace: f.root, agentPreset: 'primary' }
    expect(f.service.inspectOccurrenceAcceptance(lookup)).toMatchObject({ contractId: 'host-acceptance', bindingGeneration: 3 })
    const db = new DatabaseSync(path)
    try {
      // Simulate a crash after the run commit and before the acceptance update.
      db.prepare('UPDATE automation_task_acceptance SET quiescent = 0 WHERE task_id = ?').run(terminal!.taskId)
      expect(await f.service.inspectAcceptedExecution(accepted)).toMatchObject({
        executionRef: terminal!.runId, status: 'succeeded', quiescent: true,
      })
      const update = db.prepare('UPDATE automation_task_acceptance SET host_proof_json = ? WHERE task_id = ?')
      update.run(null, terminal!.taskId)
      expect(await f.service.inspectAcceptedExecution(accepted)).toBeNull()
      update.run(JSON.stringify({ ...proof, attemptId: 'stale-attempt' }), terminal!.taskId)
      expect(await f.service.inspectAcceptedExecution(accepted)).toBeNull()
      expect(f.service.inspectOccurrenceAcceptance(lookup)).toBeUndefined()
      update.run(JSON.stringify(proof), terminal!.taskId)

      // Bypass the immutable-run trigger in this disposable database to test a run without quiescence.
      db.exec('DROP TRIGGER automation_run_quiescence_immutable')
      const updateRun = db.prepare('UPDATE automation_runs SET quiescent = ? WHERE id = ?')
      updateRun.run(0, terminal!.runId)
      expect(await f.service.inspectAcceptedExecution(accepted)).toBeNull()
      expect(f.service.inspectOccurrenceAcceptance(lookup)).toBeUndefined()
      updateRun.run(1, terminal!.runId)
    } finally { db.close() }
    expect(await f.service.inspectAcceptedExecution(accepted)).toMatchObject({ executionRef: terminal!.runId, quiescent: true })
    advanceOwnerGeneration()
    expect(await f.service.inspectAcceptedExecution(accepted)).toBeNull()
  })

  test.each(['sink', 'owner', 'profile'] as const)('does not submit a model request without required %s', async missing => {
    const f = await harness()
    if (missing !== 'sink') enable(f, { owner: missing !== 'owner', profile: missing !== 'profile' })
    invokeRequired(f)
    await f.run()
    expect(f.adapter.requests).toHaveLength(0)
    expect(rows(join(f.root, 'automations.sqlite'), 'SELECT task_id FROM automation_task_acceptance')).toEqual([])
  })

  test('does not bind or submit when the owner changes during acceptance preparation', async () => {
    const f = await harness(), { prepare, advanceOwnerGeneration } = enable(f)
    prepare.mockImplementation(() => {
      advanceOwnerGeneration()
      return { contractId: 'host-acceptance', contractDigest: 'd'.repeat(64) }
    })
    invokeRequired(f)
    await f.run()
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(f.adapter.requests).toHaveLength(0)
    expect(rows(join(f.root, 'automations.sqlite'), 'SELECT task_id FROM automation_task_acceptance')).toEqual([])
  })

  test('does not prove a completed Agent whose outer Host budget could not settle', async () => {
    const f = await harness(), { prepare, acceptedContract } = enable(f)
    f.finalize.mockImplementation(() => { throw new Error('budget settlement unavailable') })
    f.adapter.script = () => text()
    invokeRequired(f)
    const occurrence = await f.run()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.nativeResults[0]).toMatchObject({ outcome: 'succeeded', quiescent: true })
    const accepted = { ...prepare.mock.calls[0]![0], id: acceptedContract().id, digest: acceptedContract().digest }
    expect(await f.service.inspectAcceptedExecution(accepted)).toBeNull()
    expect(f.service.inspectOccurrenceAcceptance({ automationId: f.automationId, occurrenceId: occurrence.id,
      workspace: f.root, agentPreset: 'primary' })).toBeUndefined()
  })

  test('rejects an expired contract before its first model request', async () => {
    const f = await harness()
    enable(f, { expired: true })
    invokeRequired(f)
    await f.run()
    expect(f.adapter.requests).toHaveLength(0)
    expect(rows(join(f.root, 'automations.sqlite'), 'SELECT task_id FROM automation_task_acceptance')).toEqual([])
  })

  test('blocks the generated tool call if the verifier unloads during generation', async () => {
    const f = await harness(), { unloadVerifier } = enable(f)
    f.adapter.script = () => {
      unloadVerifier()
      return toolCalls(['probe'])
    }
    invokeRequired(f)
    await f.run()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.probe).not.toHaveBeenCalled()
  })
})

describe('Host Agent synchronous authorization fence', () => {
  test('advertises version 1 and checks a synchronous owner before model/tool boundaries', async () => {
    const f = await harness(), controller = new AbortController(), check = vi.fn(() => {})
    expect(f.service.hostAgentAuthorizationVersion()).toBe(1)
    f.execute(async input => hostResult(await f.invoke(input, f.contract(), { signal: controller.signal, assertCurrent: check })))
    await f.run()
    expect(f.adapter.requests).toHaveLength(2); expect(f.probe).toHaveBeenCalledTimes(1)
    expect(check.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).toHaveBeenCalledTimes(1)
  })

  test('rechecks authorization after deferred create before the first paid request', async () => {
    const f = await harness(), entered = gate(), release = gate(), controller = new AbortController()
    const original = f.ctx.agents.create.bind(f.ctx.agents)
    vi.spyOn(f.ctx.agents, 'create').mockImplementation(async options => { const handle = await original(options); entered.resolve(); await release.promise; return handle })
    let current = true
    f.execute(async input => hostResult(await f.invoke(input, f.contract(), { signal: controller.signal, assertCurrent: () => { if (!current) throw new Error('owner revoked') } })))
    f.queue(); const running = f.drive(); await entered.promise; current = false; release.resolve(); await running
    expect(f.adapter.requests).toHaveLength(0); expect(f.probe).not.toHaveBeenCalled()
    expect(f.history()[0]).toMatchObject({ status: 'unknown' }); expect(f.finalize).toHaveBeenCalledTimes(1)
  })

  test('fences the second model request after a real first tool step changes owner authority', async () => {
    const f = await harness(), controller = new AbortController(); let current = true
    f.probe.mockImplementation(async () => { current = false; return { observed: true } })
    f.execute(async input => hostResult(await f.invoke(input, f.contract(), { signal: controller.signal, assertCurrent: () => { if (!current) throw new Error('owner revoked') } })))
    await f.run()
    expect(f.adapter.requests).toHaveLength(1); expect(f.probe).toHaveBeenCalledTimes(1)
    expect(f.history()[0]).toMatchObject({ status: 'unknown' }); expect(f.finalize).toHaveBeenCalledTimes(1)
  })

  test.each(['async','promise','thenable','getter'] as const)('rejects %s authorization without a paid request or thenable callbacks', async kind => {
    const f = await harness(), controller = new AbortController(); let getterReads = 0, thenReads = 0
    const callback = kind === 'async' ? async () => { throw new Error('async rejected') }
      : kind === 'promise' ? () => Promise.reject(new Error('native rejected promise'))
        // eslint-disable-next-line unicorn/no-thenable -- Deliberately verifies that untrusted thenable getters are never invoked.
        : () => ({ get then() { thenReads++; throw new Error('must not read then') } })
    const fence = kind === 'getter' ? Object.defineProperty({ signal: controller.signal }, 'assertCurrent', { enumerable: true, get() { getterReads++; return () => {} } })
      : { signal: controller.signal, assertCurrent: callback }
    f.execute(async input => hostResult(await f.invoke(input, f.contract(), fence as HostAgentAuthorizationFence)))
    await f.run()
    expect(f.adapter.requests).toHaveLength(0); expect(f.agents).toHaveLength(0)
    expect(getterReads).toBe(0); expect(thenReads).toBe(0)
    expect(f.finalize).toHaveBeenCalledTimes(1)
  })

  test('consumes before callback reentrancy and checks revocation after the callback', async () => {
    const f = await harness(), controller = new AbortController(); let nested: Promise<unknown> | undefined
    f.execute(async input => hostResult(await f.invoke(input, f.contract(), { signal: controller.signal, assertCurrent: () => {
      nested = f.service.runAgentForHostExecution(input, f.contract())
      void nested.catch(() => {})
      controller.abort('owner revoked')
    } })))
    await f.run()
    await expect(nested).rejects.toThrow(/exact live/u)
    expect(f.agents).toHaveLength(0); expect(f.adapter.requests).toHaveLength(0)
    expect(f.finalize).toHaveBeenCalledTimes(1)
  })
})

test('a synchronous authorization callback cannot consume a second native Agent', async () => {
  const f = await harness(), controller = new AbortController(); let nested: Promise<unknown> | undefined
  f.execute(async input => hostResult(await f.invoke(input, f.contract(), { signal: controller.signal, assertCurrent: () => {
    if (!nested) { nested = f.service.runAgentForHostExecution(input, f.contract()); void nested.catch(() => {}) }
  } })))
  await f.run(); await expect(nested).rejects.toThrow(/exact live/u)
  expect(f.agents).toHaveLength(1); expect(f.adapter.requests).toHaveLength(2)
  expect(f.finalize).toHaveBeenCalledTimes(1)
})

test('authorization changing after model tool-call output prevents the actual tool body', async () => {
  const f = await harness(), controller = new AbortController(); let current = true
  f.adapter.script = async function* () { yield* toolCalls(['probe']); current = false }
  f.execute(async input => hostResult(await f.invoke(input, f.contract(), { signal: controller.signal, assertCurrent: () => { if (!current) throw new Error('owner revoked before tool') } })))
  await f.run()
  expect(f.adapter.requests).toHaveLength(1); expect(f.probe).not.toHaveBeenCalled()
  expect(f.history()[0]).toMatchObject({ status: 'unknown' }); expect(f.finalize).toHaveBeenCalledTimes(1)
})

test('owned authorization signal abort during deferred create prevents any model request', async () => {
  const f = await harness(), entered = gate(), release = gate(), controller = new AbortController()
  const original = f.ctx.agents.create.bind(f.ctx.agents)
  vi.spyOn(f.ctx.agents, 'create').mockImplementation(async options => { const handle = await original(options); entered.resolve(); await release.promise; return handle })
  f.execute(async input => hostResult(await f.invoke(input, f.contract(), { signal: controller.signal, assertCurrent: () => {} })))
  f.queue(); const running = f.drive(); await entered.promise; controller.abort('owner revoked'); release.resolve(); await running
  expect(f.adapter.requests).toHaveLength(0); expect(f.probe).not.toHaveBeenCalled(); expect(f.finalize).toHaveBeenCalledTimes(1)
})

test('authorization callback unloading its executor and returning void is rechecked before create', async () => {
  const f = await harness(), controller = new AbortController(); let calls = 0
  f.execute(async input => hostResult(await f.invoke(input, f.contract(), { signal: controller.signal, assertCurrent: () => { calls++; f.unregister() } })))
  await f.run()
  expect(calls).toBe(1); expect(f.agents).toHaveLength(0); expect(f.adapter.requests).toHaveLength(0)
  expect(f.finalize).toHaveBeenCalledTimes(1)
})

test.each(['propagate','succeeded','forged-throw'] as const)('retains observed paid native usage when authorization is revoked (%s)', async terminal => {
  const f = await harness(), authorization = new AbortController(); let current = true
  f.adapter.script = async function* () {
    for await (const chunk of toolCalls(['probe'])) yield chunk.type === 'usage' ? { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } } : chunk
  }
  f.probe.mockImplementation(async () => { current = false; return { observed: true } })
  f.execute(async input => {
    try { return hostResult(await f.invoke(input, f.contract(), { signal: authorization.signal, assertCurrent: () => { if (!current) throw new Error('owner revoked after paid claim') } })) }
    catch (error) {
      if (terminal === 'succeeded') return hostSuccess()
      if (terminal === 'forged-throw') throw Object.assign(new Error('caller cannot supply usage'), { usage: { inputTokens: 999, outputTokens: 999, toolCalls: 999 }, sessionId: 'forged-session' })
      throw error
    }
  })
  await f.run()
  expect(f.adapter.requests).toHaveLength(1); expect(f.probe).toHaveBeenCalledTimes(1)
  const agent = f.agents[0]!
  expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message' && event.data.usage?.inputTokens === 10 && event.data.usage?.outputTokens === 4)).toBe(true)
  expect(f.history()[0]).toMatchObject({ status: 'unknown', session_id: agent.session.id, evidence_status: 'suppressed' })
  expect(JSON.parse(f.history()[0]!.usage_json as string)).toMatchObject({ inputTokens: 10, outputTokens: 4, toolCalls: 1 })
  expect(JSON.parse(f.history()[0]!.diagnostic_json as string)).toMatchObject({ sideEffectState: 'unknown', retryability: 'unsafe', budgetSettlementState: 'finalized' })
  expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).toHaveBeenCalledTimes(1)
})

test('retains observed paid usage across executor unload without accepting a late success', async () => {
  const f = await harness()
  f.adapter.script = async function* () {
    for await (const chunk of toolCalls(['probe'])) yield chunk.type === 'usage' ? { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } } : chunk
  }
  f.probe.mockImplementation(async () => { f.unregister(); return { observed: true } })
  f.execute(async input => { try { await f.invoke(input) } catch { /* Unload is uncertain even if this Host returns success. */ } return hostSuccess() })
  await f.run()
  expect(f.adapter.requests).toHaveLength(1); expect(f.probe).toHaveBeenCalledTimes(1)
  expect(f.history()[0]).toMatchObject({ status: 'unknown', session_id: f.agents[0]!.session.id })
  expect(JSON.parse(f.history()[0]!.usage_json as string)).toMatchObject({ inputTokens: 10, outputTokens: 4, toolCalls: 1, observedPartial: true })
  expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).toHaveBeenCalledTimes(1)
})

test('keeps partial paid usage when teardown is unconfirmed and ignores later disposal completion', async () => {
  const f = await harness(), release = gate(), authorization = new AbortController(); let current = true
  const create = f.ctx.agents.create.bind(f.ctx.agents), handles: AgentHandle[] = []
  vi.spyOn(f.ctx.agents, 'create').mockImplementation(async options => {
    const handle = await create(options); handles.push(handle)
    return { agent: handle.agent, async dispose() { await release.promise; await handle.dispose() } }
  })
  f.adapter.script = async function* () {
    for await (const chunk of toolCalls(['probe'])) yield chunk.type === 'usage' ? { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } } : chunk
  }
  f.probe.mockImplementation(async () => { current = false; return { observed: true } })
  f.execute(async input => {
    try { await f.invoke(input, f.contract(), { signal: authorization.signal, assertCurrent: () => { if (!current) throw new Error('owner revoked') } }) }
    catch { /* The partial audit receipt must not turn teardown uncertainty into success. */ }
    return hostSuccess()
  })
  try {
    await f.run()
    const before = structuredClone(f.history()[0])
    expect(before).toMatchObject({ status: 'unknown', session_id: f.agents[0]!.session.id })
    expect(JSON.parse(before!.usage_json as string)).toMatchObject({ inputTokens: 10, outputTokens: 4, toolCalls: 1, observedPartial: true })
    expect(f.nativeResults).toHaveLength(0); expect(f.finalize).toHaveBeenCalledTimes(1)
    release.resolve(); await Promise.all(handles.map(handle => handle.dispose())); await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.history()[0]).toEqual(before); expect(f.finalize).toHaveBeenCalledTimes(1)
  } finally { release.resolve(); await Promise.all(handles.map(handle => handle.dispose())) }
})

test('does not accept caller-supplied error usage without an internally observed Agent', async () => {
  const f = await harness()
  f.execute(async () => { throw Object.assign(new Error('forged usage'), { usage: { inputTokens: 999, outputTokens: 999, toolCalls: 999 }, sessionId: 'forged-session' }) })
  await f.run()
  expect(f.agents).toHaveLength(0); expect(f.adapter.requests).toHaveLength(0)
  expect(f.history()[0]?.status).toBe('unknown'); expect(f.history()[0]?.session_id).not.toBe('forged-session')
  expect(JSON.parse(f.history()[0]!.usage_json as string)).toEqual({})
  expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.finalize).toHaveBeenCalledTimes(1)
})

function terminalEvaluation(f: Awaited<ReturnType<typeof harness>>) {
  return JSON.parse(rows(join(f.root, 'automations.sqlite'), "SELECT payload_json FROM automation_evaluation_outbox WHERE observation_kind='terminal'")[0]!.payload_json as string)
}

test('a deterministic Host that never consumes native execution retains its fixed objective contract', async () => {
  const f = await harness(); f.execute(async () => hostSuccess()); await f.run()
  expect(f.adapter.requests).toHaveLength(0); expect(f.agents).toHaveLength(0)
  expect(terminalEvaluation(f)).toMatchObject({ executionStatus: 'succeeded', objectiveStatus: 'achieved', evaluator: { version: 'host-runbook-v1' } })
})

test('a real native tool failure followed by a normal model report never proves a Host objective', async () => {
  const f = await harness(); f.probe.mockRejectedValueOnce(new Error('fixture tool failed'))
  await f.run()
  expect(f.probe).toHaveBeenCalledTimes(1); expect(f.adapter.requests).toHaveLength(2)
  expect(f.history()[0]).toHaveProperty('status', 'succeeded')
  expect(terminalEvaluation(f)).toMatchObject({ executionStatus: 'succeeded', objectiveStatus: 'unknown', evaluator: { version: 'terminal-v1' } })
})

test('native consumption reduction survives coordinator deadline winning before teardown returns', async () => {
  const f = await harness(), started = gate(), release = gate(), disposeGate = gate()
  f.service.reconcileSystem({ owner: f.owner, automationId: f.automationId, idempotencyKey: 'short-outer-deadline', definition: { ...f.definition, timeoutMs: 1_000 } })
  f.adapter.script = request => heldText(request, started, release)
  const create = f.ctx.agents.create.bind(f.ctx.agents), handles: AgentHandle[] = []
  vi.spyOn(f.ctx.agents, 'create').mockImplementation(async options => {
    const handle = await create(options); handles.push(handle)
    return { agent: handle.agent, async dispose() { await disposeGate.promise; await handle.dispose() } }
  })
  f.execute(async invocation => hostResult(await f.invoke(invocation, f.contract({ timeoutMs: 1_000 }))))
  const running = f.run()
  try {
    await started.promise; await running
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.history()[0]).toHaveProperty('status', 'timed_out')
    expect(terminalEvaluation(f)).toMatchObject({ executionStatus: 'timed-out', objectiveStatus: 'unknown', evaluator: { version: 'terminal-v1' } })
  } finally { release.resolve(); disposeGate.resolve(); await running; await Promise.all(handles.map(handle => handle.dispose())) }
  await vi.waitFor(() => expect(f.finalize).toHaveBeenCalledTimes(1))
  expect(f.reserve).toHaveBeenCalledTimes(1)
  expect(terminalEvaluation(f)).toHaveProperty('objectiveStatus', 'unknown')
})
