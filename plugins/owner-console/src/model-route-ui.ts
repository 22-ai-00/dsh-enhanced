import { useEffect, useState } from 'react'
import type { AutonomySetupStatus, ModelCatalogItem, ModelCatalogProvider, OwnerConsoleModelCatalog, OwnerConsoleStatus } from './typert.js'
import { el, idle, inputStyle, muted, primaryButtonStyle } from './ui.js'

export const CUSTOM_MODEL_OPTION = '__custom__'

export interface EffectiveModelCatalog {
  readonly fromHostCatalog: boolean
  readonly fetchedAt: number
  readonly defaultSelection: Readonly<{ provider: string; model: string; reasoningEffort?: string }>
  readonly providers: readonly ModelCatalogProvider[]
}

export function providerDisplayName(provider: Pick<ModelCatalogProvider, 'id' | 'name' | 'kind' | 'active'>): string {
  const statusTag = provider.active ? '' : ' [未启用]'
  if (provider.kind === 'acp') {
    const label = provider.id === 'traex-agent'
      ? 'TraeX ACP'
      : provider.id === 'agy-agent'
        ? 'Antigravity ACP'
        : provider.name
    return `${label} (${provider.id})${statusTag}`
  }
  const cleanName = provider.name.trim()
  if (cleanName === '' || cleanName === provider.id) return `API: ${provider.id}${statusTag}`
  return `API: ${cleanName} (${provider.id})${statusTag}`
}

export function resolveEffectiveModelCatalog(input: Readonly<{
  modelCatalog?: OwnerConsoleModelCatalog | undefined
  status?: OwnerConsoleStatus | undefined
  autonomySetup?: AutonomySetupStatus | undefined
}>): EffectiveModelCatalog {
  const { modelCatalog, status, autonomySetup } = input
  const providers: ModelCatalogProvider[] = []
  const seen = new Set<string>()

  const pushProvider = (entry: ModelCatalogProvider) => {
    if (entry.id === '' || seen.has(entry.id)) return
    seen.add(entry.id)
    providers.push(entry)
  }

  for (const p of modelCatalog?.providers ?? []) {
    pushProvider(p)
  }

  const ensureFallbackProvider = (
    id: string,
    name: string,
    kind: 'acp' | 'api',
    active: boolean,
    fallbackModel?: string,
  ) => {
    if (seen.has(id) || id.trim() === '') return
    const models: ModelCatalogItem[] = kind === 'acp'
      ? [
        {
          id: 'default',
          name: `${id === 'agy-agent' ? 'Antigravity' : 'TraeX'} 默认当前模型 (default)`,
          efforts: [],
        },
        ...(fallbackModel && fallbackModel !== 'default'
          ? [{ id: fallbackModel, name: fallbackModel, efforts: [] }]
          : []),
      ]
      : (fallbackModel ? [{ id: fallbackModel, name: fallbackModel, efforts: [] }] : [])
    pushProvider({ id, name, kind, active, models })
  }

  const defaultProvider = modelCatalog?.defaultSelection.provider
    || autonomySetup?.modelRoute.provider
    || status?.defaultModel?.provider
    || ''
  const defaultModel = modelCatalog?.defaultSelection.model
    || autonomySetup?.modelRoute.model
    || status?.defaultModel?.model
    || ''
  const defaultEffort = modelCatalog?.defaultSelection.reasoningEffort
    ?? autonomySetup?.modelRoute.reasoningEffort
    ?? status?.defaultModel?.reasoningEffort
    ?? undefined

  for (const row of status?.llmProviders ?? []) {
    const kind = row.id === 'traex-agent' || row.id === 'agy-agent' ? 'acp' : 'api'
    ensureFallbackProvider(row.id, row.name || row.id, kind, true, defaultProvider === row.id ? defaultModel : undefined)
  }

  for (const row of autonomySetup?.modelRoute.apiProviders ?? []) {
    ensureFallbackProvider(row.id, row.name || row.id, 'api', true, defaultProvider === row.id ? defaultModel : undefined)
  }

  if (modelCatalog === undefined) {
    const traexInstalled = status?.traex !== undefined
      ? status.traex.installed
      : autonomySetup?.modelRoute.traexInstalled === true
    const agyInstalled = status?.agy !== undefined
      ? status.agy.installed
      : (autonomySetup?.modelRoute.traexInstalled === true || autonomySetup?.modelRoute.agyEnabled === true)
    if (traexInstalled) {
      ensureFallbackProvider(
        'traex-agent',
        'TraeX ACP',
        'acp',
        status?.traex?.enabled ?? autonomySetup?.modelRoute.traexEnabled ?? false,
        defaultProvider === 'traex-agent' ? defaultModel : undefined,
      )
    }
    if (agyInstalled) {
      ensureFallbackProvider(
        'agy-agent',
        'Antigravity ACP',
        'acp',
        status?.agy?.enabled ?? autonomySetup?.modelRoute.agyEnabled ?? false,
        defaultProvider === 'agy-agent' ? defaultModel : undefined,
      )
    }
  }

  if (defaultProvider !== '' && !seen.has(defaultProvider)) {
    const kind = defaultProvider === 'traex-agent' || defaultProvider === 'agy-agent' ? 'acp' : 'api'
    ensureFallbackProvider(defaultProvider, defaultProvider, kind, false, defaultModel || undefined)
  }

  return {
    fromHostCatalog: modelCatalog !== undefined,
    fetchedAt: modelCatalog?.fetchedAt ?? 0,
    defaultSelection: {
      provider: defaultProvider,
      model: defaultModel,
      ...(defaultEffort ? { reasoningEffort: defaultEffort } : {}),
    },
    providers,
  }
}

export function cascadeProviderChange(
  catalog: EffectiveModelCatalog,
  nextProvider: string,
  currentModel: string,
  currentEffort: string,
): Readonly<{ provider: string; model: string; reasoningEffort: string }> {
  const providerEntry = catalog.providers.find(p => p.id === nextProvider)
  let nextModel = ''
  if (nextProvider === catalog.defaultSelection.provider && catalog.defaultSelection.model !== '') {
    nextModel = catalog.defaultSelection.model
  } else if (providerEntry !== undefined) {
    if (providerEntry.kind === 'acp' && currentModel === 'default') {
      nextModel = 'default'
    } else if (currentModel !== '' && providerEntry.models.some(m => m.id === currentModel)) {
      nextModel = currentModel
    } else {
      nextModel = providerEntry.models[0]?.id ?? (providerEntry.kind === 'acp' ? 'default' : '')
    }
  } else if (nextProvider === 'traex-agent' || nextProvider === 'agy-agent') {
    nextModel = 'default'
  }

  const nextEffort = cascadeModelChange(catalog, nextProvider, nextModel, currentEffort).reasoningEffort
  return { provider: nextProvider, model: nextModel, reasoningEffort: nextEffort }
}

export function cascadeModelChange(
  catalog: EffectiveModelCatalog,
  providerId: string,
  nextModel: string,
  currentEffort: string,
): Readonly<{ model: string; reasoningEffort: string }> {
  const providerEntry = catalog.providers.find(p => p.id === providerId)
  const modelEntry = providerEntry?.models.find(m => m.id === nextModel)
  const nextEffort = currentEffort !== ''
    && modelEntry !== undefined
    && modelEntry.efforts.some(e => e.id === currentEffort)
    ? currentEffort
    : ''
  return { model: nextModel, reasoningEffort: nextEffort }
}

export function resolveEffortOptions(
  catalog: EffectiveModelCatalog,
  providerId: string,
  modelId: string,
  currentEffort: string,
): Readonly<{ defaultLabel: string; options: readonly Readonly<{ value: string; label: string }>[] }> {
  const providerEntry = catalog.providers.find(p => p.id === providerId)
  const modelEntry = providerEntry?.models.find(m => m.id === modelId)

  if (modelEntry !== undefined && modelEntry.efforts.length > 0) {
    const defaultLabel = modelEntry.defaultEffort
      ? `默认（${modelEntry.defaultEffort}）`
      : '默认（跟随模型）'
    const options = modelEntry.efforts.map(e => ({
      value: e.id,
      label: e.name !== e.id ? `${e.name} (${e.id})` : e.id,
    }))
    if (currentEffort !== '' && !options.some(o => o.value === currentEffort)) {
      options.push({ value: currentEffort, label: `${currentEffort}（当前值）` })
    }
    return { defaultLabel, options }
  }

  const options = currentEffort !== ''
    ? [{ value: currentEffort, label: `${currentEffort}（当前值）` }]
    : []
  const defaultLabel = catalog.fromHostCatalog && providerEntry?.active === true && modelEntry !== undefined
    ? '默认（当前模型无可选 Effort）'
    : '默认（跟随模型/工具）'
  return { defaultLabel, options }
}

export interface ModelRouteSelectsProps {
  readonly catalog: EffectiveModelCatalog
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string
  readonly disabled?: boolean
  readonly compact?: boolean
  readonly onChange: (next: Readonly<{ provider: string; model: string; reasoningEffort: string }>) => void
}

/**
 * `/model`-style cascading dropdowns for selecting `(provider, model, reasoningEffort)`.
 * Keeps manual text entry strictly hidden behind an explicit `"手动输入其他模型 ID…"` choice.
 */
export function ModelRouteSelects({
  catalog,
  provider,
  model,
  reasoningEffort,
  disabled = false,
  compact = false,
  onChange,
}: ModelRouteSelectsProps) {
  const [customModelMode, setCustomModelMode] = useState(false)
  const [customDraft, setCustomDraft] = useState(model)

  const selectedProvider = catalog.providers.find(p => p.id === provider)
  const knownModels = selectedProvider?.models ?? []
  const modelInList = knownModels.some(m => m.id === model)
  const effectiveModelOptions = !modelInList && model.trim() !== ''
    ? [...knownModels, { id: model, name: `${model}（当前配置）`, efforts: [] }]
    : knownModels

  useEffect(() => {
    setCustomModelMode(false)
  }, [provider])

  useEffect(() => {
    setCustomDraft(model)
  }, [provider, model])

  const effortInfo = resolveEffortOptions(catalog, provider, model, reasoningEffort)

  const selectStyle = compact
    ? { ...inputStyle, padding: '4px 8px', fontSize: 12, width: 'auto', minWidth: 120 }
    : inputStyle

  const providerSelect = el('select', {
    'data-model-route-select': 'provider',
    'aria-label': '模型或编程工具路由',
    disabled,
    value: provider,
    style: selectStyle,
    onChange: (event: { target: { value: string } }) => {
      setCustomModelMode(false)
      onChange(cascadeProviderChange(catalog, event.target.value, model, reasoningEffort))
    },
  },
  ...(provider === '' ? [el('option', { value: '' }, '选择路由…')] : []),
  ...catalog.providers.map(p => el('option', { key: p.id, value: p.id }, providerDisplayName(p))),
  ...(provider !== '' && !catalog.providers.some(p => p.id === provider)
    ? [el('option', { value: provider }, `${provider}（当前配置）`)]
    : []))

  const showCustomInput = customModelMode || (effectiveModelOptions.length === 0 && model.trim() === '')
  const modelSelectValue = showCustomInput
    ? CUSTOM_MODEL_OPTION
    : (model.trim() !== '' ? model : (effectiveModelOptions[0]?.id ?? CUSTOM_MODEL_OPTION))

  const modelSelect = el('select', {
    'data-model-route-select': 'model',
    'aria-label': '模型 ID',
    disabled,
    value: modelSelectValue,
    style: selectStyle,
    onChange: (event: { target: { value: string } }) => {
      const value = event.target.value
      if (value === CUSTOM_MODEL_OPTION) {
        setCustomDraft(model)
        setCustomModelMode(true)
        return
      }
      setCustomModelMode(false)
      const cascaded = cascadeModelChange(catalog, provider, value, reasoningEffort)
      onChange({ provider, ...cascaded })
    },
  },
  ...effectiveModelOptions.map(m => el('option', {
    key: m.id,
    value: m.id,
  }, m.name !== m.id ? `${m.name} (${m.id})` : m.id)),
  el('option', { value: CUSTOM_MODEL_OPTION }, '手动输入其他模型 ID…'))

  const commitCustomDraft = () => {
    if (disabled) return
    const trimmed = customDraft.trim()
    if (trimmed === '') return
    setCustomModelMode(false)
    const cascaded = cascadeModelChange(catalog, provider, trimmed, reasoningEffort)
    onChange({ provider, ...cascaded })
  }

  const applyDisabled = disabled || customDraft.trim() === ''

  const customInput = !showCustomInput
    ? null
    : compact
      ? el('input', {
        type: 'text',
        'data-model-route-custom-model': '',
        'aria-label': '自定义模型 ID',
        disabled,
        value: customDraft,
        placeholder: '输入模型 ID（如 deepseek-chat）',
        style: { ...selectStyle, minWidth: 150 },
        onChange: (event: { target: { value: string } }) => {
          setCustomDraft(event.target.value)
        },
        onKeyDown: (event: { key: string; preventDefault(): void; nativeEvent?: { isComposing?: boolean } }) => {
          if (event.key === 'Escape') {
            setCustomDraft(model)
            setCustomModelMode(false)
            return
          }
          if (event.key !== 'Enter' || event.nativeEvent?.isComposing === true) return
          event.preventDefault()
          commitCustomDraft()
        },
      })
      : el('input', {
        type: 'text',
        'data-model-route-custom-model': '',
        'aria-label': '自定义模型 ID',
        disabled,
        value: model,
        placeholder: '输入模型 ID（如 deepseek-chat）',
        style: { ...inputStyle, marginTop: 6 },
        onChange: (event: { target: { value: string } }) => {
          onChange({ provider, model: event.target.value, reasoningEffort })
        },
      })

  const customApplyButton = !showCustomInput || !compact
    ? null
    : el('button', {
      type: 'button',
      'data-model-route-custom-apply': '',
      disabled: applyDisabled,
      style: idle({ ...primaryButtonStyle, padding: '4px 10px', fontSize: 12 }, applyDisabled),
      onClick: commitCustomDraft,
    }, '应用')

  const effortSelect = el('select', {
    'data-model-route-select': 'effort',
    'aria-label': '推理强度 Effort',
    disabled,
    value: reasoningEffort,
    style: selectStyle,
    onChange: (event: { target: { value: string } }) => {
      onChange({ provider, model, reasoningEffort: event.target.value })
    },
  },
  el('option', { value: '' }, effortInfo.defaultLabel),
  ...effortInfo.options.map(opt => el('option', { key: opt.value, value: opt.value }, opt.label)))

  if (compact) {
    return el('div', {
      'data-model-route-controls': 'compact',
      style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
    }, providerSelect, modelSelect, customInput, customApplyButton, effortSelect)
  }

  return el('div', {
    'data-model-route-controls': 'grid',
    style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 },
  },
  el('label', { style: { display: 'grid', gap: 4, fontSize: 12, color: muted } },
    el('span', {}, '模型 / 编程工具路由'),
    providerSelect),
  el('label', { style: { display: 'grid', gap: 4, fontSize: 12, color: muted } },
    el('span', {}, '模型 ID（与 /model 同步）'),
    el('div', {}, modelSelect, customInput)),
  el('label', { style: { display: 'grid', gap: 4, fontSize: 12, color: muted } },
    el('span', {}, '推理强度（Effort）'),
    effortSelect))
}
