import { describe, expect, it } from 'vitest'
import type { OwnerConsoleStatus } from '../src/typert.ts'
import { componentState, missingRemedy, repairPatch } from '../src/state.ts'

type Bundle = OwnerConsoleStatus['bundles'][number]
type Plugin = OwnerConsoleStatus['plugins'][number]

const bundle = (overrides: Partial<Bundle> = {}): Bundle => ({
  name: '@dsh-ray/lark-channel', enabled: true, installed: true, removable: true,
  rows: [{ rowId: 'dsh-ray-lark-channel', moduleName: '@dsh-ray/lark-channel' }], ...overrides,
} as Bundle)
const plugin = (overrides: Partial<Plugin> = {}): Plugin => ({
  entryId: 'lark', moduleName: '@dsh-ray/lark-channel', enabled: true, fiberPhase: 'active', ...overrides,
} as Plugin)
const status = (overrides: Partial<OwnerConsoleStatus> = {}): OwnerConsoleStatus => ({
  feishu: { mode: 'env', installed: false, enabled: false, appIdConfigured: false, connected: false, connection: 'absent' },
  traex: { installed: false, enabled: false, command: '' },
  host: { settings: true, pluginManager: true, bundles: 'ok', plugins: 'ok' },
  dependencies: [
    { name: 'assistantPolicy', available: true },
    { name: 'assistantDelivery', available: false },
    { name: 'assistantSkills', available: true },
  ],
  evaluation: { intakeAgreement: 'disabled' },
  bundles: [], plugins: [], ...overrides,
} as OwnerConsoleStatus)

const LARK = '@dsh-ray/lark-channel'

describe('panel component state', () => {
  it('does not mistake an unreadable or absent Host for an uninstalled plugin', () => {
    expect(componentState(undefined, LARK)).toMatchObject({ kind: 'loading', canInstall: false })
    expect(componentState(status({ host: { settings: true, pluginManager: false, bundles: 'unavailable', plugins: 'unavailable' } }), LARK))
      .toMatchObject({ kind: 'unavailable', label: 'Host pluginManager 未加载', canInstall: false })
    expect(componentState(status({ host: { settings: true, pluginManager: true, bundles: 'failed', plugins: 'ok' } }), LARK))
      .toMatchObject({ kind: 'unreadable', canInstall: false })
    expect(componentState(status(), LARK)).toMatchObject({ kind: 'absent', canInstall: true, canEnable: false })
  })

  it('keeps an errored bundle visible and never offers install for it', () => {
    const errored = componentState(status({ bundles: [bundle({ error: { code: 'incompatible-version' } })] }), LARK)
    expect(errored).toMatchObject({ kind: 'errored', canInstall: false, canEnable: false })
    expect(errored.error).toEqual({ code: 'incompatible-version' })
    expect(componentState(status({ bundles: [bundle({ installed: false, error: { code: 'unsupported-platform' } })] }), LARK))
      .toMatchObject({ kind: 'errored', canInstall: false })
  })

  it('offers 启用 only for an installed but unselected bundle', () => {
    expect(componentState(status({ bundles: [bundle({ enabled: false })] }), LARK))
      .toMatchObject({ kind: 'disabled', label: '已安装但未启用', canEnable: true, canInstall: false, stalled: false })
  })

  it('derives active, pending, failed, busy and unloaded from the fiber, not the config flag', () => {
    const cases: ReadonlyArray<readonly [Plugin | undefined, string, boolean]> = [
      [plugin(), 'active', false],
      [plugin({ fiberPhase: 'pending' }), 'pending', true],
      [plugin({ fiberPhase: 'failed', diagnostic: 'cannot inject assistantDelivery' }), 'failed', true],
      [plugin({ fiberPhase: 'loading' }), 'busy', true],
      [plugin({ fiberPhase: 'unloading' }), 'busy', true],
      [plugin({ fiberPhase: null }), 'busy', true],
      [undefined, 'unloaded', true],
    ]
    for (const [entry, kind, stalled] of cases) {
      const state = componentState(status({ bundles: [bundle()], plugins: entry === undefined ? [] : [entry] }), LARK)
      expect(state.kind).toBe(kind)
      expect(state.stalled).toBe(stalled)
      expect(state.canEnable).toBe(false)
      expect(state.canInstall).toBe(false)
    }
    expect(componentState(status({ bundles: [bundle()], plugins: [plugin({ fiberPhase: 'pending' })] }), LARK).label)
      .toBe('已启用，等待依赖服务')
    expect(componentState(status({ bundles: [bundle()], plugins: [plugin({ fiberPhase: 'failed' })] }), LARK).label)
      .toBe('已启用但加载失败')
  })

  it('names the exact bundles that provide missing companion services', () => {
    const state = componentState(status({ bundles: [bundle()], plugins: [plugin({ fiberPhase: 'pending' })] }), LARK)
    expect(state.missing).toEqual([{ service: 'assistantDelivery', bundle: '@dsh-ray/assistant-delivery' }])
    expect(missingRemedy(state)).toContain('assistantDelivery（安装 @dsh-ray/assistant-delivery）')
    expect(componentState(status(), LARK).missing).toEqual([{ service: 'assistantDelivery', bundle: '@dsh-ray/assistant-delivery' }])
  })

  it('offers a minimal, copyable patch repair without inventing config', () => {
    const state = componentState(status({ bundles: [bundle()], plugins: [plugin({ fiberPhase: 'failed' })] }), LARK)
    const patch = repairPatch(state, LARK)
    expect(patch).toContain('- id: dsh-ray-lark-channel')
    expect(patch).toContain('  disabled: true')
    expect(patch).toContain('缺少服务 assistantDelivery：安装 @dsh-ray/assistant-delivery')
    expect(patch).not.toContain('config:')
    // Without declared rows, fall back to the panel's naming convention.
    const guessed = repairPatch(componentState(status({ bundles: [bundle({ rows: [] })] }), LARK), LARK)
    expect(guessed).toContain('- id: dsh-ray-lark-channel')
  })

  it('distinguishes installed-disabled personal-assistant and enabled-stalled assistant-delivery instead of suggesting reinstall', () => {
    const state = componentState(status({
      dependencies: [
        { name: 'assistantPolicy', available: false },
        { name: 'assistantDelivery', available: false },
        { name: 'assistantSkills', available: false },
      ],
      bundles: [
        bundle({ name: '@dsh-ray/personal-assistant', installed: true, enabled: false, rows: [{ rowId: 'dsh-ray-personal-assistant', moduleName: '@dsh-ray/personal-assistant' }] }),
        bundle({ name: '@dsh-ray/assistant-delivery', installed: true, enabled: true, rows: [{ rowId: 'dsh-ray-assistant-delivery', moduleName: '@dsh-ray/assistant-delivery' }] }),
        bundle({ name: LARK, installed: true, enabled: true }),
      ],
      plugins: [plugin({ fiberPhase: 'pending' })],
    }), LARK)
    // lark-channel ignores unrelated assistantSkills unavailability
    expect(state.missing).toEqual([
      { service: 'assistantPolicy', bundle: '@dsh-ray/personal-assistant', state: 'disabled' },
      { service: 'assistantDelivery', bundle: '@dsh-ray/assistant-delivery', state: 'stalled' },
    ])
    const remedy = missingRemedy(state)
    expect(remedy).toContain('@dsh-ray/personal-assistant 已安装但未启用')
    expect(remedy).toContain('@dsh-ray/assistant-delivery 已启用，等待前置服务')
    expect(remedy).not.toContain('安装 @dsh-ray/assistant-policy')
    expect(remedy).not.toContain('安装 @dsh-ray/assistant-delivery')
    const patch = repairPatch(state, LARK)
    expect(patch).toContain('@dsh-ray/personal-assistant 已安装但未启用')
    expect(patch).toContain('@dsh-ray/assistant-delivery 已启用但尚未就绪')
  })

  it('marks embedded personal-assistant sub-bundles as bundled when personal-assistant is active', () => {
    const s = status({
      bundles: [
        bundle({ name: '@dsh-ray/personal-assistant', enabled: true }),
        bundle({ name: '@dsh-ray/assistant-policy', enabled: false }),
        bundle({ name: '@dsh-ray/personal-memory', enabled: false }),
        bundle({ name: '@dsh-ray/personal-wiki', enabled: false }),
        bundle({ name: '@dsh-ray/assistant-automations', enabled: false }),
        bundle({ name: '@dsh-ray/assistant-work-items', enabled: false }),
      ],
      plugins: [plugin({ moduleName: '@dsh-ray/personal-assistant', fiberPhase: 'active' })],
    })
    for (const pkg of [
      '@dsh-ray/assistant-policy',
      '@dsh-ray/personal-memory',
      '@dsh-ray/personal-wiki',
      '@dsh-ray/assistant-automations',
    ]) {
      expect(componentState(s, pkg)).toMatchObject({
        kind: 'bundled',
        label: '由 personal-assistant 托管',
        tone: 'ok',
        canEnable: false,
        canInstall: false,
        stalled: false,
      })
    }
    expect(componentState(s, '@dsh-ray/assistant-work-items')).toMatchObject({
      kind: 'disabled',
      label: '已安装但未启用',
      canEnable: true,
    })
  })
})
