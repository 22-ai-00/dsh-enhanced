import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { AutomationPreparationRunner, type PreparationInput } from '../src/preparation.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

class DraftAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly requestedTool?: string) { super() }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1 && this.requestedTool !== undefined) {
      const id = ToolCallId('preparation-tool-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: this.requestedTool, argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: this.requestedTool, arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Draft the safe next step.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Draft the safe next step.' } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 6 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(options: { requestedTool?: string; budgetLimit?: number; presetTool?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-automations-preparation-')); roots.push(root)
  const ctx = new Context(); const adapter = new DraftAdapter(options.requestedTool)
  let presetMounts = 0
  const binding = { id: 'binding-1', version: 1, generation: 1, sessionId: 'owner-session' }
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  await ctx.plugin(SessionProjectionRegistry)
  ctx.provide('agentPresets' as never, { resolve: async (id?: string) => ({ id: id ?? 'primary' }), mount: async (agentCtx: Agent['ctx']) => {
    presetMounts += 1
    if (options.presetTool !== undefined) {
      agentCtx.tools.register(defineTool({ name: options.presetTool, description: 'Preset-local tool.', parameters: {},
        output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'must not execute' }))
    }
    return { id: 'primary' }
  } } as never)
  ctx.provide('assistantDelivery' as never, {
    validateOwnerRoute: vi.fn(() => ({ principalRecordId: 'owner-record', principalVersion: 3 })),
    resolveOwnerRoute: vi.fn(() => ({ binding })),
  } as never)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'),
    budgets: [{ id: 'preparation-runs', metric: 'automation-runs', limit: options.budgetLimit ?? 5, periodMs: 60_000, scope: 'subject' }],
    rules: [{ id: 'prepare', effect: 'allow', subject: { kind: 'background', id: 'assistant-proactive/v1', workspace: root, principal: 'owner' },
      actions: ['prepare'], resource: { kind: 'goal', id: 'goal-1' }, context: { initiators: ['background'] } }],
  })
  let toolExecutions = 0
  ctx.tools.register(defineTool({ name: 'must_not_run', description: 'must be denied', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] }, execute: async () => { toolExecutions += 1; return 'executed' } }))
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  return { ctx, adapter, binding, presetMounts: () => presetMounts, toolExecutions: () => toolExecutions, runner: new AutomationPreparationRunner(ctx, ctx.assistantPolicy), root }
}

function input(root: string): PreparationInput {
  return { id: 'decision-1', goalId: 'goal-1', scope: { principalId: 'owner', principalRecordId: 'owner-record', principalVersion: 3, workspace: root, preset: 'primary' },
    sessionId: 'owner-session', ownerRouteId: 'owner-route', objective: 'Prepare a bounded draft.', provider: 'mock', model: 'draft-model',
    maxOutputTokens: 128, timeoutMs: 5_000, budgetId: 'preparation-runs', expiresAt: Date.now() + 60_000 }
}

test('uses a fresh Session, real model output, no tools, and an unverified-draft result', async () => {
  const f = await fixture()
  try {
    const result = await f.runner.run({ ...input(f.root), objective: 'Prepare a bounded draft.\nKeep the owner constraints.' }, new AbortController().signal, () => {})
    expect(result).toMatchObject({ outcome: 'succeeded', output: '[unverified-draft]\nDraft the safe next step.', quiescent: true })
    expect(result.sessionId).not.toBe('owner-session')
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.adapter.requests[0]?.tools ?? []).toHaveLength(0)
  } finally { await f.ctx.fiber.restart() }
})

test('fails closed before model creation when the current Goal authority is revoked', async () => {
  const f = await fixture()
  try {
    await expect(f.runner.run(input(f.root), new AbortController().signal, () => { throw new Error('goal no longer current') }))
      .rejects.toThrow(/goal no longer current/)
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.ctx.fiber.restart() }
})

test('rechecks live Policy at the pre-prompt fence after the initial authorization', async () => {
  const f = await fixture()
  try {
    const original = f.ctx.assistantPolicy.evaluate.bind(f.ctx.assistantPolicy)
    let calls = 0
    vi.spyOn(f.ctx.assistantPolicy, 'evaluate').mockImplementation(request => {
      calls += 1
      return calls >= 4
        ? { effect: 'deny', reasonCode: 'default-deny', ruleId: undefined }
        : original(request)
    })
    const result = await f.runner.run(input(f.root), new AbortController().signal, () => {})
    expect(calls).toBeGreaterThanOrEqual(4)
    expect(result).toMatchObject({ outcome: 'unknown', quiescent: false,
      sessionId: expect.stringMatching(/^preparation-/u), usage: {},
      diagnostic: expect.objectContaining({ schemaVersion: 1, failureCode: expect.any(String) }) })
    expect(result.reason).toBe(result.diagnostic.failureCode)
    expect(result.reason).not.toContain('default-deny')
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.ctx.fiber.restart() }
})

test('fences a replacement owner binding with the same original Session before model dispatch', async () => {
  const f = await fixture()
  try {
    let assertions = 0
    const result = await f.runner.run(input(f.root), new AbortController().signal, () => {
      assertions += 1
      if (assertions === 3) f.binding.generation = 2
    })
    expect(result).toMatchObject({ outcome: 'unknown', quiescent: false })
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.ctx.fiber.restart() }
})

test('rejects a model-requested registered tool without invoking it', async () => {
  const f = await fixture({ requestedTool: 'must_not_run' })
  try {
    const result = await f.runner.run(input(f.root), new AbortController().signal, () => {})
    expect(result).not.toMatchObject({ outcome: 'succeeded' })
    expect(f.toolExecutions()).toBe(0)
    expect(f.adapter.requests).toHaveLength(1)
  } finally { await f.ctx.fiber.restart() }
})

test('uses the model-only projection and skips a preset that would register a scoped tool', async () => {
  const f = await fixture({ presetTool: 'preset_only_tool' })
  try {
    const result = await f.runner.run(input(f.root), new AbortController().signal, () => {})
    expect(result).toMatchObject({ outcome: 'succeeded', quiescent: true })
    expect(f.presetMounts()).toBe(0)
    expect(f.adapter.requests).toHaveLength(1)
  } finally { await f.ctx.fiber.restart() }
})

test('does not submit a second draft when the real automation-runs budget is exhausted', async () => {
  const f = await fixture({ budgetLimit: 1 })
  try {
    expect((await f.runner.run(input(f.root), new AbortController().signal, () => {})).outcome).toBe('succeeded')
    const exhausted = await f.runner.run({ ...input(f.root), id: 'decision-2' }, new AbortController().signal, () => {})
    expect(exhausted).toMatchObject({ outcome: 'unknown', quiescent: false })
    expect(f.adapter.requests).toHaveLength(1)
  } finally { await f.ctx.fiber.restart() }
})
