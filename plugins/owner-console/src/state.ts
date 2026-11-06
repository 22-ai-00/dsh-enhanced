import type { OwnerConsoleStatus } from './typert.js'

/** Which bundle provides each companion service this console surfaces; a missing one is actionable. */
export const DEPENDENCY_BUNDLES: Readonly<Record<string, string>> = Object.freeze({
  assistantPolicy: '@dsh-enhanced/assistant-policy',
  assistantDelivery: '@dsh-enhanced/assistant-delivery',
  assistantSkills: '@dsh-enhanced/assistant-skills',
})

export type StatusTone = 'ok' | 'warn' | 'error' | 'neutral'

/** What the panel can honestly say about one bundle: config alone cannot distinguish a disabled
 * bundle from one that is enabled but waiting, failed or missing a loader row. */
export type ComponentKind = 'loading' | 'unavailable' | 'unreadable' | 'absent' | 'errored'
  | 'disabled' | 'active' | 'pending' | 'failed' | 'busy' | 'unloaded'

export interface MissingDependency {
  readonly service: string
  readonly bundle: string
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
  active: ['已启用并加载', 'ok'],
  pending: ['已启用，等待依赖服务', 'warn'],
  failed: ['已启用但加载失败', 'error'],
  busy: ['已启用，正在加载', 'warn'],
  unloaded: ['已启用，但 Loader 没有条目', 'error'],
}

/** Derive the display state from the inventory already returned by `status()`. */
export function componentState(status: OwnerConsoleStatus | undefined, name: string): ComponentState {
  const base = (kind: ComponentKind, bundle?: ComponentState['bundle'], entry?: ComponentState['entry']): ComponentState => {
    const [label, tone] = LABELS[kind]
    const missing = kind === 'loading' || kind === 'unavailable' || kind === 'unreadable'
      ? []
      : (status?.dependencies ?? []).filter(dependency => !dependency.available)
        .map(dependency => ({ service: dependency.name, bundle: DEPENDENCY_BUNDLES[dependency.name] ?? `@dsh-enhanced/${kebab(dependency.name)}` })) ?? []
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
  if (!bundle.enabled) return base('disabled', bundle, entry)
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
  const rowId = state.bundle?.rows?.[0]?.rowId ?? `dsh-enhanced-${name.split('/').at(-1) ?? name}`
  const missing = state.missing.map(item => `# 缺少服务 ${item.service}：安装 ${item.bundle} 后重启 profile。`)
  return [
    '# 写入 profile 的 cordis.patch.yml，然后重启 profile：',
    ...missing,
    '- id: ' + rowId,
    '  disabled: true',
  ].join('\n')
}

/** One-line remedy including the exact bundle names to install. */
export function missingRemedy(state: ComponentState): string {
  return state.missing.length === 0 ? ''
    : `缺少服务：${state.missing.map(item => `${item.service}（安装 ${item.bundle}）`).join('、')}`
}

/** `assistantDelivery` -> `assistant-delivery`; used only for the three known companion services. */
function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, '$1-$2').toLowerCase()
}
