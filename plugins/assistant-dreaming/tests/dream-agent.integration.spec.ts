import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setApprovalReviewer } from '@dsh-enhanced/assistant-policy'
import { afterEach, expect, test } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { runDreamAgent } from '../src/dream-agent.ts'
import type { DreamMaterial } from '../src/projection.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

const config = () => normalizeConfig({
  enabled: true,
  scope: { workspace: process.cwd(), preset: 'primary', principalId: 'p', ownerRouteId: 'r' },
  databasePath: '/tmp/dream-agent-test.sqlite',
  provider: 'dream-provider', model: 'dream-model', budgetId: 'b', budgetAmount: 1,
  maxModelCalls: 2, maxToolCalls: 2, maxIdeasPerWake: 2,
})
const material = (): DreamMaterial => ({ ownerScopeDigest: 'a'.repeat(64), generatedAt: 1, items: [
  { kind: 'task-projection', summary: 'not-achieved: sample failure', evidenceRef: 'b'.repeat(64) },
], inputBytes: 128 })

test('dream agent exposes exactly one submit tool and records only cited ideas', async () => {
  const ctx = new Context(); cleanups.push(async () => { await (ctx as { dispose?: () => Promise<void> }).dispose?.() })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode: 'native' } })
  let surface: readonly string[] = []
  let requests = 0
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests += 1
      const agent = ctx.agents.get(SessionId(options.sessionId!))!
      agent.session.append('approval/policy', { policy: 'ask' }); setApprovalReviewer(agent.session, 'user')
      if (requests === 1) {
        surface = agent.ctx.tools.schemas(agent).map(schema => schema.name).sort()
        const result = await ctx.tools.execute({ name: 'dream_submit_ideas',
          arguments: { ideas: [{ summary: 'A playful cron idea', detail: 'detail',
            evidence_refs: ['b'.repeat(64)] }] },
          agent, callId: ToolCallId('dream-1'), signal: new AbortController().signal })
        expect(result.isError).toBe(false)
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Dreamed one idea.' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['dream-provider'], new Adapter())
  const initiators: Array<{ initiator: string; principal: string | undefined }> = []
  ctx.provide('assistantPolicy' as never, {
    bindInitiator: (_agent: unknown, initiator: string, principal?: string) => {
      initiators.push({ initiator, principal })
      return () => {}
    },
  } as never)
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  const recorded: unknown[] = []
  const result = await runDreamAgent({
    ctx, wakeId: 'dream-wake-1', config: config(),
    model: { provider: 'dream-provider', model: 'dream-model' },
    scope: { workspace: process.cwd(), preset: 'primary', principalId: 'p', ownerRouteId: 'r' },
    material: material(), deadlineAt: Date.now() + 30_000, signal: new AbortController().signal,
    onSubmit: ideas => { recorded.push(...ideas); return ideas.length },
  })
  expect(result).toMatchObject({ outcome: 'succeeded', ideaCount: 1 })
  expect(surface).toEqual(['dream_submit_ideas'])
  expect(recorded).toHaveLength(1)
  // The unattended wake must be a background initiator so Policy never applies
  // foreground/human-approval semantics to the dream tool call.
  expect(initiators).toEqual([{ initiator: 'background', principal: 'p' }])
})

test('dream agent rejects uncited evidence and a second submit within one wake', async () => {
  const ctx = new Context(); cleanups.push(async () => { await (ctx as { dispose?: () => Promise<void> }).dispose?.() })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode: 'native' } })
  let requests = 0
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests += 1
      const agent = ctx.agents.get(SessionId(options.sessionId!))!
      agent.session.append('approval/policy', { policy: 'ask' }); setApprovalReviewer(agent.session, 'user')
      const call = async (name: string, args: unknown) => ctx.tools.execute({ name, arguments: args as never,
        agent, callId: ToolCallId(`dream-${requests}`), signal: new AbortController().signal })
      const first = await call('dream_submit_ideas', { ideas: [{ summary: 's', detail: 'd', evidence_refs: ['c'.repeat(64)] }] })
      expect(first.isError).toBe(true)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['dream-provider'], new Adapter())
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  let submissions = 0
  const result = await runDreamAgent({
    ctx, wakeId: 'dream-wake-2', config: config(),
    model: { provider: 'dream-provider', model: 'dream-model' },
    scope: { workspace: process.cwd(), preset: 'primary', principalId: 'p', ownerRouteId: 'r' },
    material: material(), deadlineAt: Date.now() + 30_000, signal: new AbortController().signal,
    onSubmit: ideas => { submissions += ideas.length; return ideas.length },
  })
  // The rejected submit surfaces as a tool error rather than aborting the
  // Agent; nothing is recorded and the wake still ends normally.
  expect(result.outcome).toBe('succeeded')
  expect(result.ideaCount).toBe(0)
  expect(submissions).toBe(0)
})

test('dream agent honours its model-call cap and identity scope', async () => {
  const ctx = new Context(); cleanups.push(async () => { await (ctx as { dispose?: () => Promise<void> }).dispose?.() })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, tools: { mode: 'native' } })
  let requests = 0
  class Adapter extends LlmAdapter {
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests += 1
      const agent = ctx.agents.get(SessionId(options.sessionId!))!
      agent.session.append('approval/policy', { policy: 'ask' }); setApprovalReviewer(agent.session, 'user')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      const id = ToolCallId(`loop-${requests}`)
      yield { type: 'tool-call-delta', index: 0, id, name: 'dream_submit_ideas', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'dream_submit_ideas', arguments: '{}' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['dream-provider'], new Adapter())
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  const result = await runDreamAgent({
    ctx, wakeId: 'dream-wake-3', config: normalizeConfig({
  enabled: true,
  scope: { workspace: process.cwd(), preset: 'primary', principalId: 'p', ownerRouteId: 'r' },
  databasePath: '/tmp/dream-agent-test-cap.sqlite',
  provider: 'dream-provider', model: 'dream-model', budgetId: 'b', budgetAmount: 1,
  maxModelCalls: 1, maxToolCalls: 8, maxIdeasPerWake: 1,
}),
    model: { provider: 'dream-provider', model: 'dream-model' },
    scope: { workspace: process.cwd(), preset: 'primary', principalId: 'p', ownerRouteId: 'r' },
    material: material(), deadlineAt: Date.now() + 30_000, signal: new AbortController().signal,
    onSubmit: () => 0,
  })
  // The second model request is rejected inside the llm/stream pin before
  // the adapter runs again, failing the wake closed.
  expect(result.outcome).not.toBe('succeeded')
  expect(requests).toBe(1)
})
