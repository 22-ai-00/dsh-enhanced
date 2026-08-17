import { Context } from '@deepseek-ai/cordis'
import {
  agentEvents,
  installModelSelection,
  type Agent,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
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
    const selection: ModelSelectionRef = {
      current: { provider: 'alpha', model: 'reasoner', reasoningEffort: ReasoningEffortId('high') },
      assembled: undefined,
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
    const selection: ModelSelectionRef = {
      current: { provider: 'alpha', model: 'chat' },
      assembled: undefined,
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
    await ctx.plugin(SystemPrompt)
    const selection: ModelSelectionRef = {
      current: { provider: 'alpha', model: 'chat' },
      assembled: undefined,
    }
    installModelSelection(ctx, selection)
    const agent = {} as Agent
    const signal = new AbortController().signal
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed' }

    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'alpha', model: 'chat' })
    await setSessionConfigOption(llm(), selection, MODEL_CONFIG_ID, modelValue('alpha', 'reasoner'))
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(seed),
    )).resolves.toMatchObject({ provider: 'alpha', model: 'chat' })

    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'alpha', model: 'reasoner' })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 2, signal }, () => Promise.resolve(seed),
    )).resolves.toMatchObject({ provider: 'alpha', model: 'reasoner' })
    await ctx.fiber.dispose()
  })

  it('maps ACP modes to the four shipped DSH agent presets', async () => {
    const events: unknown[] = []
    const agent = {
      ctx: {},
      session: {
        events,
        append: (type: string, data: unknown) => events.push({ type, data }),
      },
    } as unknown as Agent
    let current = 'standard'
    const presets: NativeAgentPresetControl = {
      composedPreset: () => current,
      list: () => Promise.resolve([
        { id: 'standard', name: '标准模式', description: '标准描述' },
        { id: 'code', name: 'PTO 模式', description: 'Code 描述' },
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
        { id: 'code', name: 'PTO 模式', description: 'Code 描述' },
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

  it('hides and rejects the Bash-only minimal mode on Windows', async () => {
    const agent = {
      ctx: {},
      session: {
        id: 'windows-session',
        events: [],
        append: () => undefined,
      },
    } as unknown as Agent
    const presets: NativeAgentPresetControl = {
      composedPreset: () => 'standard',
      list: () => Promise.resolve([
        { id: 'standard' },
        { id: 'code' },
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
