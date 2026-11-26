import type { OwnerConsoleStatus } from './typert.js'

/** Which bundle provides each companion service this console surfaces; a missing one is actionable. */
export const DEPENDENCY_BUNDLES: Readonly<Record<string, string>> = Object.freeze({
  assistantPolicy: '@dsh-ray/assistant-policy',
  assistantDelivery: '@dsh-ray/assistant-delivery',
  assistantSkills: '@dsh-ray/assistant-skills',
})

const PERSONAL_ASSISTANT_PACKAGE = '@dsh-ray/personal-assistant'
const PERSONAL_ASSISTANT_SUB_BUNDLES = new Set([
  '@dsh-ray/assistant-policy',
  '@dsh-ray/personal-memory',
  '@dsh-ray/personal-wiki',
  '@dsh-ray/assistant-automations',
])
const POLICY_PROVIDER_BUNDLES = [PERSONAL_ASSISTANT_PACKAGE, '@dsh-ray/assistant-policy'] as const
const COMPONENT_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '@dsh-ray/lark-channel': ['assistantPolicy', 'assistantDelivery'],
})

export type StatusTone = 'ok' | 'warn' | 'error' | 'neutral'

/** What the panel can honestly say about one bundle: config alone cannot distinguish a disabled
 * bundle from one that is enabled but waiting, failed or missing a loader row. */
export type ComponentKind = 'loading' | 'unavailable' | 'unreadable' | 'absent' | 'errored'
  | 'disabled' | 'bundled' | 'active' | 'pending' | 'failed' | 'busy' | 'unloaded'

export interface MissingDependency {
  readonly service: string
  readonly bundle: string
  /** Present only when the providing bundle is already installed (`disabled`: needs enable; `stalled`: already enabled, waiting/failed). */
  readonly state?: 'disabled' | 'stalled'
}

export interface ComponentState {
  readonly kind: ComponentKind
  readonly label: string
  readonly tone: StatusTone
  readonly bundle?: OwnerConsoleStatus['bundles'][number]
  readonly entry?: OwnerConsoleStatus['plugins'][number]
  readonly error?: Readonly<{ code: string, diagnostic?: string | undefined }>
  readonly missing: readonly MissingDependency[]
  readonly canInstall: boolean
  readonly canEnable: boolean
  /** A loader row exists but its fiber is not active; the panel must not promise a restart will fix it. */
  readonly stalled: boolean
}

const LABELS: Readonly<Record<ComponentKind, readonly [string, StatusTone]>> = {
  loading: ['读取中…', 'neutral'],
  unavailable: ['Host pluginManager 未加载', 'error'],
  unreadable: ['插件清单读取失败', 'error'],
  absent: ['未安装', 'neutral'],
  errored: ['Host 报告错误', 'error'],
  disabled: ['已安装但未启用', 'neutral'],
  bundled: ['由 personal-assistant 托管', 'ok'],
  active: ['已启用并加载', 'ok'],
  pending: ['已启用，等待依赖服务', 'warn'],
  failed: ['已启用但加载失败', 'error'],
  busy: ['已启用，正在加载', 'warn'],
  unloaded: ['已启用，但 Loader 没有条目', 'error'],
}

function resolveMissingDependency(
  service: string,
  bundles: OwnerConsoleStatus['bundles'] | undefined,
): MissingDependency {
  const list = bundles ?? []
  if (service === 'assistantPolicy') {
    const installedProviders = POLICY_PROVIDER_BUNDLES
      .map(pkg => list.find(candidate => candidate.name === pkg && candidate.installed))
      .filter((entry): entry is OwnerConsoleStatus['bundles'][number] => entry !== undefined)
    const enabledProvider = installedProviders.find(entry => entry.enabled)
    if (enabledProvider !== undefined) {
      return { service, bundle: enabledProvider.name, state: 'stalled' }
    }
    const disabledProvider = installedProviders[0]
    if (disabledProvider !== undefined) {
      return { service, bundle: disabledProvider.name, state: 'disabled' }
    }
    return { service, bundle: DEPENDENCY_BUNDLES[service]! }
  }
  const bundleName = DEPENDENCY_BUNDLES[service] ?? `@dsh-ray/${kebab(service)}`
  const existing = list.find(candidate => candidate.name === bundleName && candidate.installed)
  if (existing !== undefined) {
    return { service, bundle: bundleName, state: existing.enabled ? 'stalled' : 'disabled' }
  }
  return { service, bundle: bundleName }
}

/** Derive the display state from the inventory already returned by `status()`. */
export function componentState(status: OwnerConsoleStatus | undefined, name: string): ComponentState {
  const scopedDeps = COMPONENT_DEPENDENCIES[name]
  const base = (kind: ComponentKind, bundle?: ComponentState['bundle'], entry?: ComponentState['entry']): ComponentState => {
    const [label, tone] = LABELS[kind]
    const missing = kind === 'loading' || kind === 'unavailable' || kind === 'unreadable'
      ? []
      : (status?.dependencies ?? [])
        .filter(dependency => !dependency.available && (scopedDeps === undefined || scopedDeps.includes(dependency.name)))
        .map(dependency => resolveMissingDependency(dependency.name, status?.bundles))
    return Object.freeze({
      kind, label, tone, missing,
      ...(bundle === undefined ? {} : { bundle }),
      ...(entry === undefined ? {} : { entry }),
      ...(bundle?.error === undefined ? {} : { error: bundle.error }),
      canInstall: kind === 'absent' && bundle?.error === undefined,
      canEnable: kind === 'disabled',
      stalled: kind === 'pending' || kind === 'failed' || kind === 'busy' || kind === 'unloaded',
    })
  }
  if (status === undefined) return base('loading')
  if (status.host?.pluginManager === false) return base('unavailable')
  if (status.host?.bundles === 'failed' || status.host?.plugins === 'failed') return base('unreadable')
  const bundle = (status.bundles ?? []).find(candidate => candidate.name === name)
  if (bundle === undefined) return base('absent')
  const entries = (status.plugins ?? []).filter(plugin => plugin.moduleName === name)
  const entry = entries[0]
  if (bundle.error !== undefined) return base('errored', bundle, entry)
  if (!bundle.installed) return base('absent', bundle, entry)
  if (!bundle.enabled) {
    if (PERSONAL_ASSISTANT_SUB_BUNDLES.has(name)) {
      const paBundle = (status.bundles ?? []).find(candidate => candidate.name === PERSONAL_ASSISTANT_PACKAGE)
      const paActive = Boolean(
        paBundle?.installed && paBundle.enabled
        && (status.plugins ?? []).some(plugin => plugin.moduleName === PERSONAL_ASSISTANT_PACKAGE && plugin.fiberPhase === 'active'),
      )
      if (paActive) return base('bundled', bundle, entry)
    }
    return base('disabled', bundle, entry)
  }
  if (entry === undefined) return base('unloaded', bundle)
  const kind: ComponentKind = entry.fiberPhase === 'active' ? 'active'
    : entry.fiberPhase === 'pending' ? 'pending'
      : entry.fiberPhase === 'failed' ? 'failed'
        : 'busy'
  return base(kind, bundle, entry)
}

/** A minimal, safe repair step: override the failing row to disabled in the profile's patch.
 * It is the only write the panel can suggest without knowing the bundle's required config. */
export function repairPatch(state: ComponentState, name: string): string {
  const rowId = state.bundle?.rows?.[0]?.rowId ?? `dsh-ray-${name.split('/').at(-1) ?? name}`
  const missing = state.missing.map(item =>
    item.state === 'disabled'
      ? `# 缺少服务 ${item.service}：${item.bundle} 已安装但未启用，请先启用后重启 profile。`
      : item.state === 'stalled'
        ? `# 缺少服务 ${item.service}：${item.bundle} 已启用但尚未就绪，请先修复前置依赖后重启 profile。`
        : `# 缺少服务 ${item.service}：安装 ${item.bundle} 后重启 profile。`,
  )
  return [
    '# 写入 profile 的 cordis.patch.yml，然后重启 profile：',
    ...missing,
    '- id: ' + rowId,
    '  disabled: true',
  ].join('\n')
}

/** One-line remedy including the exact bundle names to install or enable. */
export function missingRemedy(state: ComponentState): string {
  return state.missing.length === 0 ? ''
    : `缺少服务：${state.missing.map(item =>
      item.state === 'disabled'
        ? `${item.service}（${item.bundle} 已安装但未启用，请先启用）`
        : item.state === 'stalled'
          ? `${item.service}（${item.bundle} 已启用，等待前置服务或重启生效）`
          : `${item.service}（安装 ${item.bundle}）`,
    ).join('、')}`
}

/** `assistantDelivery` -> `assistant-delivery`; used only for the three known companion services. */
function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()
}
