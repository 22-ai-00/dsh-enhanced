import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionModeState,
} from '@agentclientprotocol/sdk'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import {
  ReasoningEffortId,
  type LlmResolvedModelInfo,
  type LlmRuntime,
} from '@deepseek-ai/dsh-llm'

export const MODEL_CONFIG_ID = 'dsh.model'
export const REASONING_CONFIG_ID = 'dsh.reasoning_effort'

export type NativeLlmControl = Pick<
  LlmRuntime,
  'listProviders' | 'listModels' | 'resolveModelInfo' | 'resolveCallConfig'
>

export interface NativeAgentPresetControl {
  composedPreset(agentCtx: Agent['ctx']): string | undefined
  list(): Promise<ReadonlyArray<{
    id: string
    name?: string
    description?: string
  }>>
  mount(agentCtx: Agent['ctx'], id?: string): Promise<{ id: string }>
  recompose(agentCtx: Agent['ctx'], id: string): Promise<{ id: string }>
  resolve(id?: string): Promise<{ id: string }>
}

export interface ModelCatalogFailure {
  provider: string
  name: string
  message: string
}

const MODES: SessionModeState['availableModes'] = [
  {
    id: 'standard',
    name: 'Standard',
    description: 'Full DSH coding agent with native tools, skills, plans, goals, subagents and workflows.',
  },
  {
    id: 'code',
    name: 'PTC',
    description: 'Standard capabilities presented through the DSH Code Mode TypeScript SDK.',
  },
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Persistent bash and str_replace_editor only.',
  },
  {
    id: 'cordis',
    name: 'Creator',
    description: 'Standard capabilities plus runtime inspection, plugin experiments and preset authoring.',
  },
]

const MODE_IDS = new Set(MODES.map(mode => mode.id))

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function selected(selection: ModelSelectionRef): ModelSelection {
  if (selection.current === undefined) throw new Error('the DSH session has no model selection')
  return selection.current
}

export function modelValue(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

function decodeModelValue(value: string | boolean): { provider: string; model: string } {
  if (typeof value !== 'string') throw new Error('model selection must be a string value')
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      Array.isArray(parsed)
      && parsed.length === 2
      && typeof parsed[0] === 'string'
      && parsed[0].length > 0
      && typeof parsed[1] === 'string'
      && parsed[1].length > 0
    ) return { provider: parsed[0], model: parsed[1] }
  } catch {
    // The common error below is intentionally stable for every malformed value.
  }
  throw new Error(`invalid DSH model selection: ${value}`)
}

export function reasoningValue(effort: string | undefined): string {
  return effort === undefined ? JSON.stringify(['default']) : JSON.stringify(['effort', effort])
}

function decodeReasoningValue(value: string | boolean): string | undefined {
  if (typeof value !== 'string') throw new Error('reasoning selection must be a string value')
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] === 'default') return undefined
    if (
      Array.isArray(parsed)
      && parsed.length === 2
      && parsed[0] === 'effort'
      && typeof parsed[1] === 'string'
      && parsed[1].length > 0
    ) return parsed[1]
  } catch {
    // The common error below is intentionally stable for every malformed value.
  }
  throw new Error(`invalid DSH reasoning selection: ${value}`)
}

function modelMeta(info: LlmResolvedModelInfo): NonNullable<SessionConfigSelectOption['_meta']> {
  return {
    dsh: {
      provider: info.provider,
      model: info.id,
      ...(info.inputModalities === undefined ? {} : { inputModalities: [...info.inputModalities] }),
      ...(info.context === undefined ? {} : { contextWindow: info.context.contextWindow }),
      ...(info.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: info.defaultMaxTokens }),
      ...(info.reasoning === undefined
        ? {}
        : {
            reasoning: {
              efforts: info.reasoning.efforts.map(effort => ({
                id: String(effort.id),
                name: effort.name,
                ...(effort.description === undefined ? {} : { description: effort.description }),
              })),
              ...(info.reasoning.defaultEffort === undefined
                ? {}
                : { defaultEffort: String(info.reasoning.defaultEffort) }),
            },
          }),
    },
  }
}

async function catalog(llm: NativeLlmControl, current: ModelSelection): Promise<{
  groups: SessionConfigSelectGroup[]
  failures: ModelCatalogFailure[]
}> {
  const rows = await Promise.all(llm.listProviders().map(async (provider) => {
    try {
      const models = await llm.listModels(provider.id)
      const options = await Promise.all(models.map(async (model): Promise<SessionConfigSelectOption> => {
        const info = await llm.resolveModelInfo(provider.id, model.id)
        return {
          value: modelValue(provider.id, model.id),
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          _meta: modelMeta(info),
        }
      }))
      return {
        kind: 'group' as const,
        group: { group: provider.id, name: provider.name, options } satisfies SessionConfigSelectGroup,
      }
    } catch (error: unknown) {
      return {
        kind: 'failure' as const,
        failure: { provider: provider.id, name: provider.name, message: message(error) },
      }
    }
  }))
  const groups = rows.flatMap(row => row.kind === 'group' && row.group.options.length > 0 ? [row.group] : [])
  const failures = rows.flatMap(row => row.kind === 'failure' ? [row.failure] : [])
  const currentValue = modelValue(current.provider, current.model)
  if (!groups.some(group => group.options.some(option => option.value === currentValue))) {
    let meta: NonNullable<SessionConfigSelectOption['_meta']>
    try {
      meta = modelMeta(await llm.resolveModelInfo(current.provider, current.model))
    } catch (error: unknown) {
      meta = { dsh: { provider: current.provider, model: current.model, metadataFailure: message(error) } }
    }
    groups.unshift({
      group: '_dsh_current',
      name: 'Current route',
      options: [{ value: currentValue, name: current.model, _meta: meta }],
    })
  }
  return { groups, failures }
}

export async function buildSessionConfigOptions(
  llm: NativeLlmControl,
  selection: ModelSelectionRef,
): Promise<SessionConfigOption[]> {
  const current = selected(selection)
  const { groups, failures } = await catalog(llm, current)
  let info: LlmResolvedModelInfo | undefined
  let reasoningFailure: string | undefined
  try {
    info = await llm.resolveModelInfo(current.provider, current.model)
  } catch (error: unknown) {
    reasoningFailure = message(error)
  }

  const efforts = info?.reasoning?.efforts ?? []
  const effortOptions: SessionConfigSelectOption[] = [
    {
      value: reasoningValue(undefined),
      name: 'Provider default',
      description: 'Clear an explicit effort and let the selected route apply its native default.',
    },
    ...efforts.map((effort): SessionConfigSelectOption => ({
      value: reasoningValue(String(effort.id)),
      name: effort.name,
      ...(effort.description === undefined ? {} : { description: effort.description }),
    })),
  ]
  if (
    current.reasoningEffort !== undefined
    && !efforts.some(effort => effort.id === current.reasoningEffort)
  ) {
    effortOptions.push({
      value: reasoningValue(String(current.reasoningEffort)),
      name: String(current.reasoningEffort),
      description: 'Current effort is not advertised by the latest model catalog.',
    })
  }

  return [
    {
      id: MODEL_CONFIG_ID,
      name: 'Model',
      description: 'DSH provider route and model. Changes apply to the next safely assembled step.',
      category: 'model',
      type: 'select',
      currentValue: modelValue(current.provider, current.model),
      options: groups,
      _meta: { dsh: { catalogFailures: failures } },
    },
    {
      id: REASONING_CONFIG_ID,
      name: 'Reasoning effort',
      description: 'Reasoning levels advertised by the exact selected DSH model.',
      category: 'thought_level',
      type: 'select',
      currentValue: reasoningValue(current.reasoningEffort === undefined
        ? undefined
        : String(current.reasoningEffort)),
      options: effortOptions,
      _meta: {
        dsh: {
          ...(info?.reasoning?.defaultEffort === undefined
            ? {}
            : { defaultEffort: String(info.reasoning.defaultEffort) }),
          ...(reasoningFailure === undefined ? {} : { catalogFailure: reasoningFailure }),
        },
      },
    },
  ]
}

export async function setSessionConfigOption(
  llm: NativeLlmControl,
  selection: ModelSelectionRef,
  configId: string,
  value: string | boolean,
): Promise<SessionConfigOption[]> {
  if (configId === MODEL_CONFIG_ID) {
    const route = decodeModelValue(value)
    const resolved = await llm.resolveCallConfig(route)
    selection.current = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    }
  } else if (configId === REASONING_CONFIG_ID) {
    const current = selected(selection)
    const effort = decodeReasoningValue(value)
    if (effort === undefined) {
      await llm.resolveCallConfig({ provider: current.provider, model: current.model })
      selection.current = { provider: current.provider, model: current.model }
    } else {
      const resolved = await llm.resolveCallConfig({
        provider: current.provider,
        model: current.model,
        reasoningEffort: ReasoningEffortId(effort),
      })
      selection.current = {
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      }
    }
  } else {
    throw new Error(`unknown DSH session config option: ${configId}`)
  }
  return buildSessionConfigOptions(llm, selection)
}

export async function modeState(
  presets: NativeAgentPresetControl,
  agent: Agent,
): Promise<SessionModeState> {
  const currentModeId = presets.composedPreset(agent.ctx)
  if (currentModeId === undefined) throw new Error('the DSH session has no composed agent preset')
  if (!MODE_IDS.has(currentModeId)) {
    throw new Error(`unsupported DSH agent preset for ACP mode: ${currentModeId}`)
  }
  const nativeModes = new Map((await presets.list()).map(preset => [preset.id, preset]))
  return {
    currentModeId,
    availableModes: MODES.map((mode) => {
      const native = nativeModes.get(mode.id)
      return {
        ...mode,
        ...(native?.name === undefined ? {} : { name: native.name }),
        ...(native?.description === undefined ? {} : { description: native.description }),
      }
    }),
    _meta: { dsh: { kind: 'agent-preset' } },
  }
}

export async function setNativeMode(
  presets: NativeAgentPresetControl,
  agent: Agent,
  modeId: string,
): Promise<{ agentPreset: string }> {
  if (!MODE_IDS.has(modeId)) throw new Error(`unknown mode: ${modeId}`)
  if (agent.session.events.some(event => event.type === 'turn/start')) {
    throw new Error(`session "${agent.session.id}" has already started; its agent preset is fixed`)
  }
  const preset = await presets.recompose(agent.ctx, modeId)
  agent.session.append('agent-preset/selected', { agentPreset: preset.id })
  return { agentPreset: preset.id }
}
