// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { jsx } from 'react/jsx-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CUSTOM_BUNDLE_OPTION,
  INSTALL_ALL_AVAILABLE_OPTION,
  OWNER_CONSOLE_PACKAGE,
  PERSONAL_ASSISTANT_PACKAGE,
  PERSONAL_ASSISTANT_SPLIT_PACKAGES,
  PROJECT_BUNDLE_CATALOG,
  resolveUninstalledBundles,
} from '../src/bundle-catalog.js'
import {
  installAvailableBundles,
  OwnerConsoleSettingsPanel,
  WenyaoSettingsSection,
  type ConsoleRemote,
} from '../src/client.js'
import { BundlesCard } from '../src/settings-cards.js'
import type { OwnerConsoleStatus } from '../src/typert.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function baseStatus(overrides: Partial<OwnerConsoleStatus> = {}): OwnerConsoleStatus {
  return {
    feishu: { mode: 'env', installed: false, enabled: false, appIdConfigured: false, connected: false, connection: 'absent' },
    traex: { installed: false, enabled: false, command: '' },
    agy: { installed: false, enabled: false, command: '' },
    defaultModel: { available: false, provider: '', model: '' },
    llmProviders: [{ id: 'deepseek', name: 'DeepSeek API' }],
    host: { settings: true, pluginManager: true, bundles: 'ok', plugins: 'ok' },
    dependencies: [],
    bundles: [],
    plugins: [],
    evaluation: { intakeAgreement: 'absent' },
    ...overrides,
  }
}

function makeBundle(name: string, overrides: Partial<OwnerConsoleStatus['bundles'][number]> = {}) {
  return {
    name,
    installed: true,
    enabled: true,
    removable: name !== OWNER_CONSOLE_PACKAGE,
    rows: [{ rowId: name.replace('@dsh-ray/', 'dsh-ray-'), moduleName: name }],
    ...overrides,
  }
}

function makeRemote(overrides: Partial<ConsoleRemote> = {}): ConsoleRemote {
  const noopWrite = async () => ({ ok: true as const, value: { applied: true, entry: 'ok', note: '已变更（applied）' } })
  return {
    status: async () => ({ ok: true, value: baseStatus() }),
    trendSnapshots: async () => ({ ok: false, error: { code: 'unavailable', message: 'unused' } }),
    intakeAgreement: async () => ({ ok: false, error: { code: 'unavailable', message: 'unused' } }),
    intakeAgreementHistory: async () => ({ ok: false, error: { code: 'unavailable', message: 'unused' } }),
    configureFeishu: noopWrite,
    configureTraex: noopWrite,
    configureBundle: noopWrite,
    setBundleEnabled: noopWrite,
    setPluginEnabled: noopWrite,
    installProjectBundle: noopWrite,
    removeProjectBundle: noopWrite,
    ...overrides,
  }
}

async function flushUi() {
  await act(async () => {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 12))
  })
}

function changeSelect(select: HTMLSelectElement, value: string) {
  const setSelectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  setSelectValue.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function changeInput(input: HTMLInputElement, value: string) {
  const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setInputValue.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('PROJECT_BUNDLE_CATALOG and resolveUninstalledBundles', () => {
  it('stays synchronized with all plugins/* packages and respects provider-before-consumer order', () => {
    const pluginsDir = resolve(import.meta.dirname, '../..')
    const diskPackages = readdirSync(pluginsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => {
        const pkgJson = JSON.parse(readFileSync(resolve(pluginsDir, entry.name, 'package.json'), 'utf8')) as { name: string }
        return pkgJson.name
      })
      .sort()

    const catalogNames = PROJECT_BUNDLE_CATALOG.map(entry => entry.name)
    expect(new Set(catalogNames).size).toBe(catalogNames.length)
    expect([...catalogNames].sort()).toEqual(diskPackages)

    for (const entry of PROJECT_BUNDLE_CATALOG) {
      expect(entry.label.trim().length).toBeGreaterThan(0)
      expect(entry.label).not.toContain('含依赖')
      expect(entry.excludeReason ?? '').not.toContain('含依赖')
    }

    const pos = new Map<string, number>(catalogNames.map((name, idx) => [name, idx]))
    const orderedPairs: ReadonlyArray<readonly [string, string]> = [
      ['@dsh-ray/personal-assistant', '@dsh-ray/assistant-goals'],
      ['@dsh-ray/personal-assistant', '@dsh-ray/assistant-memory-learning'],
      ['@dsh-ray/personal-assistant', '@dsh-ray/memory-wiki-bridge'],
      ['@dsh-ray/assistant-delivery', '@dsh-ray/assistant-proactive'],
      ['@dsh-ray/assistant-delivery', '@dsh-ray/assistant-work-items'],
      ['@dsh-ray/assistant-evaluation', '@dsh-ray/assistant-verifier'],
      ['@dsh-ray/assistant-evaluation', '@dsh-ray/assistant-growth-driver'],
      ['@dsh-ray/assistant-goals', '@dsh-ray/assistant-growth-driver'],
      ['@dsh-ray/assistant-verifier', '@dsh-ray/assistant-growth-experiments'],
      ['@dsh-ray/assistant-verifier', '@dsh-ray/assistant-growth-driver'],
      ['@dsh-ray/assistant-skills', '@dsh-ray/assistant-growth-driver'],
      ['@dsh-ray/assistant-memory-learning', '@dsh-ray/assistant-growth-driver'],
      ['@dsh-ray/assistant-dreaming', '@dsh-ray/assistant-growth-driver'],
      ['@dsh-ray/assistant-work-items', '@dsh-ray/assistant-proactive'],
      ['@dsh-ray/assistant-proactive', '@dsh-ray/assistant-heartbeat'],
      ['@dsh-ray/credentials-keychain', '@dsh-ray/lark-channel'],
    ]
    for (const [provider, consumer] of orderedPairs) {
      expect(pos.get(provider), `${provider} should precede ${consumer}`).toBeLessThan(pos.get(consumer)!)
    }
  })

  it('handles undefined, host-unavailable, standard, personal-assistant, split, and fully-installed states', () => {
    expect(resolveUninstalledBundles(undefined)).toEqual({
      ready: false,
      hostUnavailable: false,
      available: [],
      excluded: [],
      all: [],
    })

    expect(resolveUninstalledBundles(baseStatus({
      host: { settings: true, pluginManager: false, bundles: 'ok', plugins: 'ok' },
    }))).toEqual({
      ready: false,
      hostUnavailable: true,
      available: [],
      excluded: [],
      all: [],
    })

    const fresh = resolveUninstalledBundles(baseStatus())
    expect(fresh.ready).toBe(true)
    expect(fresh.available[0]?.name).toBe(PERSONAL_ASSISTANT_PACKAGE)
    expect(fresh.available.some(b => b.name === OWNER_CONSOLE_PACKAGE)).toBe(false)
    expect(fresh.excluded.map(b => b.name)).toEqual([
      ...PERSONAL_ASSISTANT_SPLIT_PACKAGES,
      '@dsh-ray/assistant-isolation',
      '@dsh-ray/acp',
      '@dsh-ray/assistant-web-owner',
      '@dsh-ray/hello',
    ])
    expect(fresh.available).toHaveLength(27)
    expect(fresh.excluded.find(b => b.name === '@dsh-ray/assistant-isolation')?.excludeReason).toContain('CLI')
    expect(fresh.all.some(b => b.name === '@dsh-ray/assistant-isolation')).toBe(true)

    const withPa = resolveUninstalledBundles(baseStatus({
      bundles: [makeBundle(OWNER_CONSOLE_PACKAGE), makeBundle(PERSONAL_ASSISTANT_PACKAGE)],
    }))
    expect(withPa.available.some(b => b.name === PERSONAL_ASSISTANT_PACKAGE)).toBe(false)
    expect(withPa.available).toHaveLength(26)
    expect(withPa.excluded.find(b => b.name === '@dsh-ray/assistant-policy')?.excludeReason).toContain('personal-assistant')

    const splitActive = resolveUninstalledBundles(baseStatus({
      bundles: [makeBundle('@dsh-ray/assistant-policy', { enabled: true })],
    }))
    expect(splitActive.excluded.find(b => b.name === PERSONAL_ASSISTANT_PACKAGE)?.excludeReason).toContain('冲突')
    expect(splitActive.available.some(b => b.name === '@dsh-ray/personal-memory')).toBe(true)
    expect(splitActive.available.some(b => b.name === '@dsh-ray/assistant-policy')).toBe(false)

    const paAndSplitCollision = resolveUninstalledBundles(baseStatus({
      bundles: [
        makeBundle(PERSONAL_ASSISTANT_PACKAGE),
        makeBundle('@dsh-ray/assistant-policy', { enabled: true }),
      ],
    }))
    expect(paAndSplitCollision.available.some(b => b.name === '@dsh-ray/personal-memory')).toBe(false)
    expect(paAndSplitCollision.available.some(b => b.name === '@dsh-ray/personal-wiki')).toBe(false)
    expect(paAndSplitCollision.available.some(b => b.name === '@dsh-ray/assistant-automations')).toBe(false)
    expect(paAndSplitCollision.excluded.find(b => b.name === '@dsh-ray/personal-memory')?.excludeReason).toContain('personal-assistant')

    const allStandardInstalled = resolveUninstalledBundles(baseStatus({
      bundles: fresh.available.map(item => makeBundle(item.name)),
    }))
    expect(allStandardInstalled.ready).toBe(true)
    expect(allStandardInstalled.available).toEqual([])
    expect(allStandardInstalled.excluded.some(b => b.name === '@dsh-ray/hello')).toBe(true)
    expect(allStandardInstalled.excluded.some(b => b.name === '@dsh-ray/assistant-isolation')).toBe(true)
  })
})

describe('installAvailableBundles helper', () => {
  it('installs deduplicated packages in order, handles build approval, cancellation, empty lists, and rejections', async () => {
    expect(await installAvailableBundles({ installProjectBundle: vi.fn() }, [], () => true)).toEqual({
      requested: [],
      completed: [],
      needsRestart: false,
      stoppedByUser: false,
    })

    const calls: Array<{ spec: string; approved: readonly string[] }> = []
    const seenProgress: number[] = []
    const okSummary = await installAvailableBundles(
      {
        installProjectBundle: async (spec, approved) => {
          calls.push({ spec, approved })
          if (spec === '@dsh-ray/lark-channel' && approved.length === 0) {
            return {
              ok: true,
              value: { applied: false, entry: spec, note: 'blocked', pendingBuilds: ['protobufjs'] },
            }
          }
          return {
            ok: true,
            value: {
              applied: true,
              entry: spec,
              note: spec === '@dsh-ray/assistant-goals'
                ? '已变更（restart-required）；需要重启 profile 后生效'
                : '已变更（applied）',
            },
          }
        },
      },
      [' @dsh-ray/assistant-goals ', '@dsh-ray/lark-channel', '@dsh-ray/assistant-goals'],
      () => true,
      { onProgress: progress => seenProgress.push(progress.index) },
    )

    expect(calls).toEqual([
      { spec: '@dsh-ray/assistant-goals', approved: [] },
      { spec: '@dsh-ray/lark-channel', approved: [] },
      { spec: '@dsh-ray/lark-channel', approved: ['protobufjs'] },
    ])
    expect(seenProgress).toEqual([0, 1])
    expect(okSummary).toEqual({
      requested: ['@dsh-ray/assistant-goals', '@dsh-ray/lark-channel'],
      completed: ['@dsh-ray/assistant-goals', '@dsh-ray/lark-channel'],
      needsRestart: true,
      stoppedByUser: false,
    })

    let cancelRequested = false
    const cancelledSummary = await installAvailableBundles(
      {
        installProjectBundle: async spec => {
          if (spec === '@dsh-ray/assistant-goals') cancelRequested = true
          return { ok: true, value: { applied: true, entry: spec, note: '已变更（applied）' } }
        },
      },
      ['@dsh-ray/assistant-goals', '@dsh-ray/assistant-skills', '@dsh-ray/assistant-verifier'],
      () => true,
      { shouldCancel: () => cancelRequested },
    )
    expect(cancelledSummary).toEqual({
      requested: ['@dsh-ray/assistant-goals', '@dsh-ray/assistant-skills', '@dsh-ray/assistant-verifier'],
      completed: ['@dsh-ray/assistant-goals'],
      needsRestart: false,
      stoppedByUser: true,
    })

    const declinedSummary = await installAvailableBundles(
      {
        installProjectBundle: async spec => spec === '@dsh-ray/assistant-goals'
          ? { ok: true, value: { applied: true, entry: spec, note: 'ok' } }
          : { ok: true, value: { applied: false, entry: spec, note: '需要批准 build', pendingBuilds: ['esbuild'] } },
      },
      ['@dsh-ray/assistant-goals', '@dsh-ray/lark-channel'],
      () => false,
    )
    expect(declinedSummary).toEqual({
      requested: ['@dsh-ray/assistant-goals', '@dsh-ray/lark-channel'],
      completed: ['@dsh-ray/assistant-goals'],
      needsRestart: false,
      stoppedByUser: false,
      failure: { spec: '@dsh-ray/lark-channel', reason: '需要批准 build' },
    })

    const rejectedSummary = await installAvailableBundles(
      {
        installProjectBundle: async spec => {
          if (spec === '@dsh-ray/assistant-skills') throw new Error('network lost')
          return { ok: true, value: { applied: true, entry: spec, note: 'ok' } }
        },
      },
      ['@dsh-ray/assistant-goals', '@dsh-ray/assistant-skills'],
      () => true,
    )
    expect(rejectedSummary).toEqual({
      requested: ['@dsh-ray/assistant-goals', '@dsh-ray/assistant-skills'],
      completed: ['@dsh-ray/assistant-goals'],
      needsRestart: false,
      stoppedByUser: false,
      failure: { spec: '@dsh-ray/assistant-skills', reason: 'network lost' },
    })

    let cancelDuringPendingBuilds = false
    const confirmDuringCancel = vi.fn(() => true)
    const cancelledPendingBuildsSummary = await installAvailableBundles(
      {
        installProjectBundle: async spec => {
          if (spec === '@dsh-ray/lark-channel') {
            cancelDuringPendingBuilds = true
            return {
              ok: true,
              value: { applied: false, entry: spec, note: '需要批准 build', pendingBuilds: ['esbuild'] },
            }
          }
          return { ok: true, value: { applied: true, entry: spec, note: 'ok' } }
        },
      },
      ['@dsh-ray/assistant-goals', '@dsh-ray/lark-channel'],
      confirmDuringCancel,
      { shouldCancel: () => cancelDuringPendingBuilds },
    )
    expect(confirmDuringCancel).not.toHaveBeenCalled()
    expect(cancelledPendingBuildsSummary).toEqual({
      requested: ['@dsh-ray/assistant-goals', '@dsh-ray/lark-channel'],
      completed: ['@dsh-ray/assistant-goals'],
      needsRestart: false,
      stoppedByUser: true,
    })
  })
})

describe('BundlesCard DOM interactions in OwnerConsoleSettingsPanel & WenyaoSettingsSection', () => {
  const mounted: Array<{ root: Root; el: HTMLElement }> = []
  afterEach(async () => {
    for (const item of mounted.splice(0)) {
      await act(async () => { item.root.unmount() })
      item.el.remove()
    }
  })

  function mountPanel(element: ReturnType<typeof jsx>) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    mounted.push({ root, el })
    act(() => { root.render(element) })
    return el
  }

  it('supports picking an uninstalled bundle from dropdown, manual custom typing, and batch-installing all available bundles with cancellation and refresh', async () => {
    let installed = new Set<string>([OWNER_CONSOLE_PACKAGE, PERSONAL_ASSISTANT_PACKAGE])
    let pendingResolver: (() => void) | undefined
    let holdOnSpec: string | undefined

    const installCalls: string[] = []
    const remote = makeRemote({
      status: async () => ({
        ok: true,
        value: baseStatus({
          bundles: [...installed].map(name => makeBundle(name)),
        }),
      }),
      installProjectBundle: async spec => {
        installCalls.push(spec)
        if (holdOnSpec === spec) {
          await new Promise<void>(resolveWait => { pendingResolver = resolveWait })
        }
        installed.add(spec)
        return { ok: true, value: { applied: true, entry: spec, note: `已安装 ${spec}` } }
      },
    })

    const el = mountPanel(jsx(OwnerConsoleSettingsPanel, {
      remote,
      navigation: { openConversation: vi.fn(), openPlugins: vi.fn() },
    }))
    await flushUi()

    const select = () => el.querySelector('[data-bundle-install-select]') as HTMLSelectElement
    const input = () => el.querySelector('[data-bundle-install-input]') as HTMLInputElement

    expect(select()).not.toBeNull()
    expect(input()).not.toBeNull()
    expect(select().querySelector(`option[value="${OWNER_CONSOLE_PACKAGE}"]`)).toBeNull()
    expect(select().querySelector(`option[value="${PERSONAL_ASSISTANT_PACKAGE}"]`)).toBeNull()
    expect(select().querySelector('option[value="@dsh-ray/assistant-isolation"]')).not.toBeNull()
    expect(select().querySelector(`option[value="${INSTALL_ALL_AVAILABLE_OPTION}"]`)?.textContent).toContain('26')

    // 1. Pick a bundle from the dropdown -> syncs to input and installs cleanly, then resets on refresh.
    await act(async () => { changeSelect(select(), '@dsh-ray/assistant-goals') })
    expect(input().value).toBe('@dsh-ray/assistant-goals')
    expect(el.textContent).toContain('已选：持久化长期业务目标管理')

    const installBtn = [...el.querySelectorAll('button')].find(btn => btn.textContent === '安装')!
    await act(async () => { installBtn.click() })
    await flushUi()
    expect(installCalls).toEqual(['@dsh-ray/assistant-goals'])
    expect(input().value).toBe('@dsh-ray/')
    expect(select().querySelector(`option[value="${INSTALL_ALL_AVAILABLE_OPTION}"]`)?.textContent).toContain('25')

    // 2. Typing an already-installed package name manually is NOT wiped by useEffect, and picking CUSTOM preserves custom value.
    await act(async () => { changeInput(input(), PERSONAL_ASSISTANT_PACKAGE) })
    expect(input().value).toBe(PERSONAL_ASSISTANT_PACKAGE)

    await act(async () => { changeSelect(select(), CUSTOM_BUNDLE_OPTION) })
    await act(async () => { changeInput(input(), '@dsh-ray/hello') })
    const customInstallBtn = [...el.querySelectorAll('button')].find(btn => btn.textContent === '安装')!
    await act(async () => { customInstallBtn.click() })
    await flushUi()
    expect(installCalls).toEqual(['@dsh-ray/assistant-goals', '@dsh-ray/hello'])

    // 3. Picking a single uninstalled bundle, then switching to INSTALL_ALL_AVAILABLE_OPTION resets input, previews targets, and cancelling stops cleanly mid-batch.
    await act(async () => { changeSelect(select(), '@dsh-ray/assistant-evaluation') })
    expect(input().value).toBe('@dsh-ray/assistant-evaluation')
    await act(async () => { changeSelect(select(), INSTALL_ALL_AVAILABLE_OPTION) })
    expect(input().value).toBe('@dsh-ray/')
    const preview = el.querySelector('[data-bundle-install-all-preview]')
    expect(preview).not.toBeNull()
    expect(preview?.textContent).toContain('@dsh-ray/assistant-evaluation')
    expect(preview?.textContent).toContain('@dsh-ray/assistant-isolation')
    expect(preview?.textContent).toContain('@dsh-ray/acp')

    holdOnSpec = '@dsh-ray/assistant-evaluation'
    const batchBtn = [...el.querySelectorAll('button')].find(btn => btn.textContent?.includes('一键安装全部可用插件'))!
    act(() => { batchBtn.click() })
    await flushUi()

    const progressBanner = el.querySelector('[data-bundle-batch-progress]')
    expect(progressBanner).not.toBeNull()
    expect(progressBanner?.textContent).toContain('正在批量安装可用插件（1/25）：@dsh-ray/assistant-evaluation')

    const stopBtn = [...el.querySelectorAll('button')].find(btn => btn.textContent === '停止后续安装')!
    act(() => { stopBtn.click() })
    expect(el.textContent).toContain('正在完成当前包后停止')

    pendingResolver?.()
    holdOnSpec = undefined
    await flushUi()

    expect(installCalls).toEqual([
      '@dsh-ray/assistant-goals',
      '@dsh-ray/hello',
      '@dsh-ray/assistant-evaluation',
    ])
    expect(el.textContent).toContain('已停止后续安装：已完成 1/25 个（@dsh-ray/assistant-evaluation）')

    // 4. Finish remaining 24 available bundles while an uninstalled name is typed in input -> both dropdown and input reset cleanly when all complete.
    await act(async () => { changeSelect(select(), '@dsh-ray/assistant-verifier') })
    expect(input().value).toBe('@dsh-ray/assistant-verifier')
    const remainingBtn = [...el.querySelectorAll('button')].find(btn => btn.textContent === '一键安装全部可用插件（24）')!
    await act(async () => { remainingBtn.click() })
    await flushUi()

    expect(installCalls).toHaveLength(27)
    expect(el.textContent).toContain('已一键安装 24 个可用插件')
    expect(input().value).toBe('@dsh-ray/')
    expect(select().value).toBe('')
    expect([...el.querySelectorAll('button')].find(btn => btn.textContent === '全部可用插件已安装')?.disabled).toBe(true)
  })

  it('exposes uninstalled picker and one-click batch install inside left-sidebar WenyaoSettingsSection', async () => {
    const installed: string[] = []
    const remote = makeRemote({
      status: async () => ({
        ok: true,
        value: baseStatus({ bundles: installed.map(name => makeBundle(name)) }),
      }),
      installProjectBundle: async spec => {
        installed.push(spec)
        return { ok: true, value: { applied: true, entry: spec, note: '已变更（applied）' } }
      },
    })

    const el = mountPanel(jsx(WenyaoSettingsSection, {
      remote,
      navigation: { openConversation: vi.fn(), openPlugins: vi.fn() },
    }))
    await flushUi()

    const channelsTab = [...el.querySelectorAll('button')].find(btn => btn.textContent?.includes('飞书与插件'))!
    await act(async () => { channelsTab.click() })
    await flushUi()

    const oneClick = [...el.querySelectorAll('button')].find(btn => btn.textContent === '一键安装全部可用插件（27）')
    expect(oneClick).toBeDefined()
    await act(async () => { oneClick!.click() })
    await flushUi()

    expect(installed[0]).toBe('@dsh-ray/personal-assistant')
    expect(installed).toHaveLength(27)
    expect(installed).not.toContain(OWNER_CONSOLE_PACKAGE)
    expect(installed).not.toContain('@dsh-ray/assistant-isolation')
    expect(installed).not.toContain('@dsh-ray/acp')
    expect(installed).not.toContain('@dsh-ray/assistant-web-owner')
    expect(installed).not.toContain('@dsh-ray/hello')
  })

  it('shows completed prefix notice and failure alert when batch install stops on build-approval refusal or Host error', async () => {
    const installed: string[] = []
    const remote = makeRemote({
      status: async () => ({
        ok: true,
        value: baseStatus({ bundles: installed.map(name => makeBundle(name)) }),
      }),
      installProjectBundle: async spec => {
        if (spec === '@dsh-ray/assistant-evaluation') {
          return { ok: false, error: { code: 'PNPM_FAILED', message: 'offline registry' } }
        }
        installed.push(spec)
        return { ok: true, value: { applied: true, entry: spec, note: '已变更（applied）' } }
      },
    })

    const el = mountPanel(jsx(OwnerConsoleSettingsPanel, {
      remote,
      navigation: { openConversation: vi.fn(), openPlugins: vi.fn() },
    }))
    await flushUi()

    const oneClick = [...el.querySelectorAll('button')].find(btn => btn.textContent === '一键安装全部可用插件（27）')!
    await act(async () => { oneClick.click() })
    await flushUi()

    expect(installed).toEqual(['@dsh-ray/personal-assistant'])
    expect(el.querySelector('[role="status"]')?.textContent).toContain('已安装 1/27 个插件（@dsh-ray/personal-assistant）')
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('安装 @dsh-ray/assistant-evaluation 时停止：PNPM_FAILED：offline registry')
  })

  it('preserves already-installed input typed before initial status loads and refreshes on fallback partial failure', async () => {
    let resolveInitialStatus: ((value: { ok: true; value: OwnerConsoleStatus }) => void) | undefined
    const statusPromise = new Promise<{ ok: true; value: OwnerConsoleStatus }>(resolveStatus => {
      resolveInitialStatus = resolveStatus
    })

    const el = mountPanel(jsx(OwnerConsoleSettingsPanel, {
      remote: makeRemote({ status: () => statusPromise }),
      navigation: { openConversation: vi.fn(), openPlugins: vi.fn() },
    }))

    const input = () => el.querySelector('[data-bundle-install-input]') as HTMLInputElement
    await act(async () => { changeInput(input(), OWNER_CONSOLE_PACKAGE) })
    expect(input().value).toBe(OWNER_CONSOLE_PACKAGE)

    resolveInitialStatus?.({
      ok: true,
      value: baseStatus({ bundles: [makeBundle(OWNER_CONSOLE_PACKAGE)] }),
    })
    await flushUi()
    expect(input().value).toBe(OWNER_CONSOLE_PACKAGE)

    const refresh = vi.fn(async () => undefined)
    const run = vi.fn(async (action: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>) => {
      const outcome = await action()
      expect(outcome.ok).toBe(false)
      expect(outcome.error?.message).toContain('已安装 1/27 个')
    })
    const installedFallback: string[] = []
    const fallbackEl = mountPanel(jsx(BundlesCard, {
      ctrl: {
        status: baseStatus({ bundles: [makeBundle(OWNER_CONSOLE_PACKAGE)] }),
        busy: false,
        confirmOwner: () => true,
        refresh,
        run,
        remote: makeRemote({
          installProjectBundle: async spec => {
            if (spec === '@dsh-ray/assistant-evaluation') {
              return { ok: false, error: { code: 'PNPM_FAILED', message: 'broken' } }
            }
            installedFallback.push(spec)
            return { ok: true, value: { applied: true, entry: spec, note: 'ok' } }
          },
        }),
      } as never,
    }))
    const fallbackBtn = [...fallbackEl.querySelectorAll('button')].find(btn => btn.textContent === '一键安装全部可用插件（27）')!
    await act(async () => { fallbackBtn.click() })
    await flushUi()

    expect(installedFallback).toEqual(['@dsh-ray/personal-assistant'])
    expect(run).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)

    const prevConfirm = (globalThis as { confirm?: unknown }).confirm
    delete (globalThis as { confirm?: unknown }).confirm
    try {
      const noConfirmEl = mountPanel(jsx(OwnerConsoleSettingsPanel, {
        remote: makeRemote({
          status: async () => ({
            ok: true,
            value: baseStatus({ bundles: [makeBundle(OWNER_CONSOLE_PACKAGE)] }),
          }),
          installProjectBundle: async spec => ({
            ok: true,
            value: { applied: false, entry: spec, note: 'raw-pending-note', pendingBuilds: ['esbuild'] },
          }),
        }),
        navigation: { openConversation: vi.fn(), openPlugins: vi.fn() },
      }))
      await flushUi()
      const btn = [...noConfirmEl.querySelectorAll('button')].find(item => item.textContent === '一键安装全部可用插件（27）')!
      await act(async () => { btn.click() })
      await flushUi()
      expect(noConfirmEl.querySelector('[role="alert"]')?.textContent).toContain('当前界面没有确认对话框')
    } finally {
      if (prevConfirm !== undefined) (globalThis as { confirm?: unknown }).confirm = prevConfirm
    }
  })
})
