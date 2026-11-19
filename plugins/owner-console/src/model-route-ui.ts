import { useEffect, useState } from 'react'
import type { AutonomySetupStatus, ModelCatalogItem, ModelCatalogProvider, OwnerConsoleModelCatalog, OwnerConsoleStatus } from './typert.js'
import { borderStrong, el, idle, inputStyle, muted, primaryButtonStyle } from './ui.js'

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

function compactProviderDisplayName(provider: Pick<ModelCatalogProvider, 'id' | 'name' | 'kind' | 'active'>): string {
  const statusTag = provider.active ? '' : ' · 未启用'
  if (provider.kind === 'acp') {
    const label = provider.id === 'traex-agent'
      ? 'TraeX'
      : provider.id === 'agy-agent'
        ? 'Antigravity'
        : (provider.name.trim() || provider.id)
    return `${label}${statusTag}`
  }
  const cleanName = provider.name.trim()
  return `${cleanName !== '' ? cleanName : provider.id}${statusTag}`
}

function compactModelDisplayName(model: Pick<ModelCatalogItem, 'id' | 'name'>): string {
  if (model.id === 'default') return '默认模型'
  const cleanName = model.name.trim()
  return cleanName !== '' ? cleanName : model.id
}

function CompactChevron() {
  return el('svg', {
    'aria-hidden': 'true',
    focusable: 'false',
    viewBox: '0 0 12 12',
    width: 11,
    height: 11,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: { flex: 'none', pointerEvents: 'none', opacity: 0.58 },
  }, el('path', { d: 'M3 4.5 6 7.5 9 4.5' }))
}

function wrapCompactSelect(label: string, maxWidth: number, selectNode: unknown, disabled: boolean) {
  return el('span', {
    'data-chat-select-wrap': disabled ? 'disabled' : '',
    style: {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 2.5,
      height: 26,
      padding: '0 4px 0 6px',
      borderRadius: 7,
      background: 'var(--oc-btn-bg, transparent)',
      color: `var(--oc-btn-fg, ${muted})`,
      fontSize: 12,
      fontWeight: 500,
      lineHeight: '26px',
      opacity: disabled ? 0.5 : 1,
      flex: '0 1 auto',
      minWidth: 0,
      maxWidth: maxWidth + 24,
      transition: 'background 140ms ease, color 140ms ease',
    },
  },
  el('span', {
    'aria-hidden': 'true',
    style: { minWidth: 0, maxWidth, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  }, label),
  CompactChevron(),
  selectNode)
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
  const selectedModelEntry = knownModels.find(m => m.id === model)
  const compactDefaultEffortLabel = selectedModelEntry?.defaultEffort
    ? `默认 · ${selectedModelEntry.defaultEffort}`
    : '默认'

  const compactOverlaySelectStyle = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    margin: 0,
    opacity: 0,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 12,
  } as const

  const providerSelect = el('select', {
    'data-model-route-select': 'provider',
    'aria-label': '模型或编程工具路由',
    title: selectedProvider !== undefined ? providerDisplayName(selectedProvider) : (provider || '模型或编程工具路由'),
    disabled,
    value: provider,
    style: compact ? compactOverlaySelectStyle : inputStyle,
    onChange: (event: { target: { value: string } }) => {
      setCustomModelMode(false)
      onChange(cascadeProviderChange(catalog, event.target.value, model, reasoningEffort))
    },
  },
  ...(provider === '' ? [el('option', { value: '' }, '选择路由…')] : []),
  ...catalog.providers.map(p => el('option', { key: p.id, value: p.id }, compact ? compactProviderDisplayName(p) : providerDisplayName(p))),
  ...(provider !== '' && !catalog.providers.some(p => p.id === provider)
    ? [el('option', { value: provider }, compact ? provider : `${provider}（当前配置）`)]
    : []))

  // In compact chat mode, never auto-open the custom input box while the catalog is loading or absent (`provider === ''`).
  const showCustomInput = customModelMode
    || (effectiveModelOptions.length === 0 && model.trim() === '' && (!compact || (provider.trim() !== '' && !disabled)))
  const modelSelectValue = showCustomInput
    ? CUSTOM_MODEL_OPTION
    : (model.trim() !== '' ? model : (effectiveModelOptions[0]?.id ?? CUSTOM_MODEL_OPTION))

  const modelSelect = el('select', {
    'data-model-route-select': 'model',
    'aria-label': '模型 ID',
    title: model.trim() !== '' ? `模型：${model}` : '选择模型 ID',
    disabled,
    value: modelSelectValue,
    style: compact ? compactOverlaySelectStyle : inputStyle,
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
  }, compact ? compactModelDisplayName(m) : (m.name !== m.id ? `${m.name} (${m.id})` : m.id))),
  el('option', { value: CUSTOM_MODEL_OPTION }, compact ? '自定义模型 ID…' : '手动输入其他模型 ID…'))

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
        placeholder: '输入模型 ID…',
        style: {
          padding: '0 8px',
          height: 26,
          borderRadius: 8,
          border: `1px solid ${borderStrong}`,
          background: 'transparent',
          color: 'inherit',
          fontSize: 12,
          lineHeight: '24px',
          width: 144,
          minWidth: 108,
          boxSizing: 'border-box',
        },
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
      style: idle({ ...primaryButtonStyle, height: 26, padding: '0 10px', borderRadius: 8, fontSize: 12, lineHeight: '24px' }, applyDisabled),
      onClick: commitCustomDraft,
    }, '应用')

  const customCancelButton = !showCustomInput || !compact || effectiveModelOptions.length === 0
    ? null
    : el('button', {
      type: 'button',
      'data-chat-ghost-btn': '',
      'aria-label': '取消自定义模型',
      title: '取消（Esc）',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        padding: 0,
        borderRadius: 6,
        border: 'none',
        background: 'var(--oc-btn-bg, transparent)',
        color: `var(--oc-btn-fg, ${muted})`,
        fontSize: 14,
        lineHeight: 1,
        cursor: 'pointer',
        flex: 'none',
        transition: 'background 140ms ease, color 140ms ease',
      },
      onClick: () => {
        setCustomDraft(model)
        setCustomModelMode(false)
      },
    }, '×')

  const effortSelect = el('select', {
    'data-model-route-select': 'effort',
    'aria-label': '推理强度 Effort',
    title: reasoningEffort !== '' ? `推理强度：${reasoningEffort}` : `推理强度：${effortInfo.defaultLabel}`,
    disabled,
    value: reasoningEffort,
    style: compact ? compactOverlaySelectStyle : inputStyle,
    onChange: (event: { target: { value: string } }) => {
      onChange({ provider, model, reasoningEffort: event.target.value })
    },
  },
  el('option', { value: '' }, compact ? compactDefaultEffortLabel : effortInfo.defaultLabel),
  ...effortInfo.options.map(opt => {
    const compactLabel = selectedModelEntry?.efforts.find(e => e.id === opt.value)?.name ?? opt.value
    return el('option', { key: opt.value, value: opt.value }, compact ? compactLabel : opt.label)
  }))

  if (compact) {
    const providerDisplay = selectedProvider !== undefined
      ? compactProviderDisplayName(selectedProvider)
      : (provider !== '' ? provider : '选择路由')
    const modelDisplay = showCustomInput
      ? '自定义模型'
      : selectedModelEntry !== undefined
        ? compactModelDisplayName(selectedModelEntry)
        : (model.trim() !== '' ? model : '选择模型')
    const effortDisplay = reasoningEffort !== ''
      ? (selectedModelEntry?.efforts.find(e => e.id === reasoningEffort)?.name ?? reasoningEffort)
      : compactDefaultEffortLabel
    const showCompactEffort = effortInfo.options.length > 0 || reasoningEffort !== ''

    const selectorGroup = el('div', {
      style: { display: 'inline-flex', alignItems: 'center', gap: 1, minWidth: 0, maxWidth: '100%' },
    },
    wrapCompactSelect(providerDisplay, 156, providerSelect, disabled),
    wrapCompactSelect(modelDisplay, 154, modelSelect, disabled),
    showCompactEffort ? wrapCompactSelect(effortDisplay, 76, effortSelect, disabled) : null)

    return el('div', {
      'data-model-route-controls': 'compact',
      style: {
        display: 'inline-flex',
        gap: 4,
        flexWrap: showCustomInput ? 'wrap' : 'nowrap',
        alignItems: 'center',
        justifyContent: 'flex-end',
        minWidth: 0,
        maxWidth: '100%',
      },
    },
    selectorGroup,
    showCustomInput
      ? el('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' } },
        customInput,
        customApplyButton,
        customCancelButton)
      : null)
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
