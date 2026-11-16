import { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
} from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, createMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  MODEL_CONFIG_ID,
  REASONING_CONFIG_ID,
  buildSessionConfigOptions,
  modelValue,
  modeState,
  reasoningValue,
  setNativeMode,
  setSessionConfigOption,
  type ModelSelectionState,
  type NativeAgentPresetControl,
  type NativeLlmControl,
} from '../src/control.ts'

function llm(): NativeLlmControl {
  return {
    listProviders: () => [
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta' },
    ],
    listModels: provider => Promise.resolve(provider === 'alpha'
      ? [
          { provider, id: 'chat', name: 'Chat' },
          { provider, id: 'reasoner', name: 'Reasoner', description: 'Thinks before answering.' },
        ]
      : [{ provider, id: 'fast', name: 'Fast' }]),
    resolveModelInfo: (provider, model) => Promise.resolve({
      provider,
      id: model,
      name: model === 'reasoner' ? 'Reasoner' : model,
      ...(model === 'reasoner'
        ? {
            context: { contextWindow: 128_000 },
            reasoning: {
              efforts: [
                { id: ReasoningEffortId('low'), name: 'Low' },
                { id: ReasoningEffortId('high'), name: 'High', description: 'Maximum reasoning.' },
              ],
              defaultEffort: ReasoningEffortId('low'),
            },
          }
        : {}),
    }),
    resolveCallConfig: config => Promise.resolve({
      provider: config.provider ?? 'alpha',
      model: config.model ?? 'chat',
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    }),
  }
}

describe('ACP native session controls', () => {
  it('publishes DSH provider/model and exact-model reasoning metadata', async () => {
    const selection: ModelSelectionState = {
      current: { provider: 'alpha', model: 'reasoner', reasoningEffort: ReasoningEffortId('high') },
    }
    const options = await buildSessionConfigOptions(llm(), selection)
    const model = options.find(option => option.id === MODEL_CONFIG_ID)
    const effort = options.find(option => option.id === REASONING_CONFIG_ID)

    expect(model).toMatchObject({
      type: 'select',
      category: 'model',
      currentValue: modelValue('alpha', 'reasoner'),
    })
    expect(model?.type === 'select' ? model.options : []).toEqual([
      expect.objectContaining({ group: 'alpha', name: 'Alpha', options: [
        expect.objectContaining({ value: modelValue('alpha', 'chat'), name: 'Chat' }),
        expect.objectContaining({
          value: modelValue('alpha', 'reasoner'),
          name: 'Reasoner',
          _meta: { dsh: expect.objectContaining({ contextWindow: 128_000 }) },
        }),
      ] }),
      expect.objectContaining({ group: 'beta', name: 'Beta' }),
    ])
    expect(effort).toMatchObject({
      type: 'select',
      category: 'thought_level',
      currentValue: reasoningValue('high'),
      options: [
        expect.objectContaining({ value: reasoningValue(undefined), name: 'Provider default' }),
        expect.objectContaining({ value: reasoningValue('low'), name: 'Low' }),
        expect.objectContaining({ value: reasoningValue('high'), name: 'High' }),
      ],
    })
  })

  it('switches the model and reasoning on the same native selection ref', async () => {
    const selection: ModelSelectionState = {
      current: { provider: 'alpha', model: 'chat' },
    }

    await setSessionConfigOption(llm(), selection, MODEL_CONFIG_ID, modelValue('alpha', 'reasoner'))
    expect(selection.current).toEqual({ provider: 'alpha', model: 'reasoner' })

    await setSessionConfigOption(llm(), selection, REASONING_CONFIG_ID, reasoningValue('high'))
    expect(selection.current).toEqual({
      provider: 'alpha',
      model: 'reasoner',
      reasoningEffort: ReasoningEffortId('high'),
    })

    await setSessionConfigOption(llm(), selection, REASONING_CONFIG_ID, reasoningValue(undefined))
    expect(selection.current).toEqual({ provider: 'alpha', model: 'reasoner' })
  })

  it('keeps prompt assembly and request routing atomic across an in-session switch', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' } })
    await ctx.plugin(AgentLoop, { agents: [] })
    const requests: GenerateOptions[] = []
    class RecordingAdapter extends LlmAdapter {
      override resolveModel(provider: string, model: string) {
        return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 64_000 } })
      }
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        const text = `reply-${requests.length}`
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['alpha'], new RecordingAdapter())
    ctx.systemPrompt.section({
      name: 'selected-model',
      order: 100,
      text: 'MODEL={{provider}}/{{model}}',
    })

    const selection: ModelSelectionState = { current: { provider: 'alpha', model: 'chat' } }
    const handle = await ctx.agents.create({
      sessionId: SessionId('atomic-switch'),
      agentOptions: { provider: 'alpha', model: 'chat' },
      setup: (agentCtx, agent) => {
        installModelSelection(agentCtx)
        agent.model.select(selection.current!)
      },
    })
    let switchedDuringFirstRequest = false
    handle.agent.ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      if (!switchedDuringFirstRequest) {
        switchedDuringFirstRequest = true
        await setSessionConfigOption(llm(), selection, MODEL_CONFIG_ID, modelValue('alpha', 'reasoner'))
        handle.agent.model.select(selection.current!)
      }
      return config
    })

    handle.agent.followup(createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] }))
    await handle.agent.whenIdle()
    handle.agent.followup(createMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] }))
    await handle.agent.whenIdle()

    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ provider: 'alpha', model: 'chat' })
    expect(JSON.stringify(requests[0]?.messages[0])).toContain('MODEL=alpha/chat')
    expect(requests[1]).toMatchObject({ provider: 'alpha', model: 'reasoner' })
    expect(JSON.stringify(requests[1]?.messages[0])).toContain('MODEL=alpha/reasoner')
    expect(JSON.stringify(requests[1]?.messages)).toContain('model changed')
    await handle.dispose()
    await ctx.fiber.dispose()
  })

  it('maps ACP modes to the four shipped DSH agent presets', async () => {
    const events: unknown[] = []
    const agent = {
      ctx: {},
      session: {
        snapshotEvents: () => events,
        append: (type: string, data: unknown) => events.push({ type, data }),
      },
    } as unknown as Agent
    let current = 'standard'
    const presets: NativeAgentPresetControl = {
      composedPreset: () => current,
      list: () => Promise.resolve([
        { id: 'standard', name: '标准模式', description: '标准描述' },
        { id: 'ptc', name: 'PTC 模式', description: 'Code 描述' },
        { id: 'minimal', name: '极简模式', description: '极简描述' },
        { id: 'cordis', name: '创造模式', description: '创造描述' },
      ]),
      mount: (_agentCtx, id) => Promise.resolve({ id: id ?? current }),
      recompose: (_agentCtx, id) => {
        current = id
        return Promise.resolve({ id })
      },
      resolve: id => Promise.resolve({ id: id ?? current }),
    }

    await expect(modeState(presets, agent, 'linux')).resolves.toMatchObject({
      currentModeId: 'standard',
      availableModes: [
        { id: 'standard', name: '标准模式', description: '标准描述' },
        { id: 'code', name: 'PTC 模式', description: 'Code 描述' },
        { id: 'minimal', name: '极简模式', description: '极简描述' },
        { id: 'cordis', name: '创造模式', description: '创造描述' },
      ],
    })
    await expect(setNativeMode(presets, agent, 'minimal', 'linux')).resolves.toEqual({ agentPreset: 'minimal' })
    await expect(modeState(presets, agent, 'linux')).resolves.toMatchObject({ currentModeId: 'minimal' })
    expect(events).toEqual([{ type: 'agent-preset/selected', data: { agentPreset: 'minimal' } }])
    await expect(setNativeMode(presets, agent, 'unknown', 'linux')).rejects.toThrow(/unknown mode/)

    events.push({ type: 'turn/start', data: { turn: 1 } })
    await expect(setNativeMode(presets, agent, 'code', 'linux')).rejects.toThrow(/already started/)
    expect(current).toBe('minimal')
  })

  it('uses DSH’s ptc preset behind the stable ACP code mode and recognizes old code sessions', async () => {
    const events: unknown[] = []
    let current = 'standard'
    const recompose = (id: string) => {
      current = id
      return Promise.resolve({ id })
    }
    const agent = {
      ctx: {},
      session: { snapshotEvents: () => events, append: (type: string, data: unknown) => events.push({ type, data }) },
    } as unknown as Agent
    const presets: NativeAgentPresetControl = {
      composedPreset: () => current,
      list: () => Promise.resolve([{ id: 'standard' }, { id: 'ptc', name: 'PTC' }, { id: 'minimal' }, { id: 'cordis' }]),
      mount: (_agentCtx, id) => Promise.resolve({ id: id ?? current }),
      recompose: (_agentCtx, id) => recompose(id),
      resolve: id => Promise.resolve({ id: id ?? current }),
    }

    await expect(setNativeMode(presets, agent, 'code', 'linux')).resolves.toEqual({ agentPreset: 'ptc' })
    await expect(modeState(presets, agent, 'linux')).resolves.toMatchObject({ currentModeId: 'code' })

    current = 'code'
    await expect(modeState(presets, agent, 'linux')).resolves.toMatchObject({ currentModeId: 'code' })

    const legacySelections: string[] = []
    const legacyAgent = {
      ctx: {},
      session: { snapshotEvents: () => [], append: () => undefined },
    } as unknown as Agent
    const legacyPresets: NativeAgentPresetControl = {
      composedPreset: () => 'code',
      list: () => Promise.resolve([{ id: 'standard' }, { id: 'code' }, { id: 'minimal' }, { id: 'cordis' }]),
      mount: (_agentCtx, id) => Promise.resolve({ id: id ?? 'code' }),
      recompose: (_agentCtx, id) => {
        legacySelections.push(id)
        return Promise.resolve({ id })
      },
      resolve: id => Promise.resolve({ id: id ?? 'code' }),
    }
    await expect(setNativeMode(legacyPresets, legacyAgent, 'code', 'linux')).resolves.toEqual({ agentPreset: 'code' })
    expect(legacySelections).toEqual(['code'])
  })

  it('hides and rejects the Bash-only minimal mode on Windows', async () => {
    const agent = {
      ctx: {},
      session: {
        id: 'windows-session',
        snapshotEvents: () => [],
        append: () => undefined,
      },
    } as unknown as Agent
    const presets: NativeAgentPresetControl = {
      composedPreset: () => 'standard',
      list: () => Promise.resolve([
        { id: 'standard' },
        { id: 'ptc' },
        { id: 'minimal' },
        { id: 'cordis' },
      ]),
      mount: (_agentCtx, id) => Promise.resolve({ id: id ?? 'standard' }),
      recompose: (_agentCtx, id) => Promise.resolve({ id }),
      resolve: id => Promise.resolve({ id: id ?? 'standard' }),
    }

    await expect(modeState(presets, agent, 'win32')).resolves.toMatchObject({
      currentModeId: 'standard',
      availableModes: [
        { id: 'standard' },
        { id: 'code' },
        { id: 'cordis' },
      ],
    })
    await expect(setNativeMode(presets, agent, 'minimal', 'win32')).rejects.toThrow(
      /minimal.*not available on Windows/i,
    )
  })
})
