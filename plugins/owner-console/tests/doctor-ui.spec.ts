// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BundleConfigSlotView, ModelsProviderSetupCard, WenyaoSettingsSection, type ConsoleRemote,
} from '../src/client.ts'
import type { CodingToolProbe, OwnerConsoleStatus, SetupDoctorReport } from '../src/typert.ts'

describe('doctor repair card, models provider card and easy feishu UI', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
  })

  function makeStatus(): OwnerConsoleStatus {
    return {
      feishu: { entry: 'dsh-enhanced-lark-channel', mode: 'handle', installed: true, enabled: true, appIdConfigured: false, connected: false, connection: 'disconnected' },
      traex: { entry: 'dsh-enhanced-traex-acp-provider', installed: true, enabled: false, command: 'traex' },
      agy: { entry: 'dsh-enhanced-traex-acp-provider', installed: true, enabled: false, command: 'agy' },
      defaultModel: { entry: 'agent-default-model', available: true, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      llmProviders: [{ id: 'deepseek-official', name: 'DeepSeek' }],
      host: { settings: true, pluginManager: true, bundles: 'ok', plugins: 'ok' },
      dependencies: [],
      evaluation: { intakeAgreement: 'absent' },
      bundles: [],
      plugins: [],
    }
  }

  function makeRemote() {
    const report: SetupDoctorReport = {
      protocol: 'owner-console/setup-doctor/v1',
      checkedAt: 100,
      profileName: 'desktop',
      dshHome: '/tmp/.dsh',
      frozenSystemdProfile: false,
      writable: true,
      healthy: false,
      autoFixableCount: 2,
      restartRequiredHint: true,
      issues: [
        {
          id: 'gui-stdio-acp-conflict',
          severity: 'error',
          category: 'plugins',
          title: '@dsh-enhanced/acp 与桌面/Web 端内置 Host 冲突',
          detail: '停用重复的 acp 插件即可恢复正常。',
          autoFixable: true,
          fixLabel: '停用冲突的 @dsh-enhanced/acp',
        },
        {
          id: 'agy-auth-required',
          severity: 'info',
          category: 'acp',
          title: 'Antigravity (agy) CLI 已安装，需要终端完成一次登录',
          detail: '请终端执行 login 命令后重测。',
          autoFixable: false,
          fixLabel: '需终端登录一次',
          copyCommand: '/Users/owner/.local/bin/agy acp --login',
        },
      ],
    }
    const applyDoctorRepair = vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'setup-doctor', note: '修复完成' } }))
    const configureTraex = vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'dsh-enhanced-traex-acp-provider', note: 'ok' } }))
    const configureAgy = vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'dsh-enhanced-traex-acp-provider', note: 'ok' } }))
    const setDefaultModelRoute = vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'agent-default-model', note: 'ok' } }))
    const configureFeishuEasy = vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'dsh-enhanced-lark-channel', note: '已安全存入钥匙串' } }))
    const probeCodingTool = vi.fn(async (tool: 'traex' | 'agy'): Promise<{ ok: true; value: CodingToolProbe }> => ({
      ok: true,
      value: {
        tool,
        command: `/Users/owner/.local/bin/${tool}`,
        installed: true,
        binaryFound: true,
        loggedIn: true,
        enabled: false,
        routeRegistered: false,
        ready: false,
        state: 'disabled',
        summary: '已就绪',
        discoveredPath: `/Users/owner/.local/bin/${tool}`,
        needsPathPin: true,
        checkedAt: 100,
        cached: false,
      },
    }))
    const remote: ConsoleRemote = {
      status: vi.fn(async () => ({ ok: true as const, value: makeStatus() })),
      trendSnapshots: vi.fn(async () => ({ ok: true as const, value: { state: 'ok' as const, causal: false as const, items: [] } })),
      intakeAgreement: vi.fn(async () => ({ ok: true as const, value: { state: 'absent' as const, causal: false as const } })),
      intakeAgreementHistory: vi.fn(async () => ({ ok: true as const, value: { state: 'absent' as const, causal: false as const } })),
      configureFeishu: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'r', note: 'ok' } })),
      configureTraex,
      configureAgy,
      configureBundle: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'r', note: 'ok' } })),
      setBundleEnabled: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'r', note: 'ok' } })),
      setPluginEnabled: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'r', note: 'ok' } })),
      installProjectBundle: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'r', note: 'ok' } })),
      removeProjectBundle: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'r', note: 'ok' } })),
      probeCodingTool,
      setDefaultModelRoute,
      setupDoctor: vi.fn(async () => ({ ok: true as const, value: report })),
      applyDoctorRepair,
      configureFeishuEasy,
    }
    return { remote, applyDoctorRepair, configureTraex, setDefaultModelRoute, configureFeishuEasy }
  }

  it('renders DoctorRepairCard, invokes applyDoctorRepair, and offers inline-confirmed one-click restart when repair requires restart', async () => {
    const { remote, applyDoctorRepair } = makeRemote()
    const restartProfile = vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'profile-restart', note: '正在自动退出并重新打开 DeepSeek Harness.app' } }))
    applyDoctorRepair.mockResolvedValueOnce({
      ok: true as const,
      value: { applied: true, entry: 'setup-doctor', note: '已补齐 assistant-verifier 缺失的 databasePath。请重启 profile 后生效' },
    })
    const remoteWithRestart: ConsoleRemote = { ...remote, restartProfile }
    const navigation = { openConversation: vi.fn(), openPlugins: vi.fn() }
    await act(async () => {
      root.render(createElement(WenyaoSettingsSection, { remote: remoteWithRestart, navigation }))
    })
    await act(async () => { await Promise.resolve() })

    expect(container.textContent).toContain('系统体检与一键自动修复')
    expect(container.textContent).toContain('@dsh-enhanced/acp 与桌面/Web 端内置 Host 冲突')
    expect(container.textContent).toContain('/Users/owner/.local/bin/agy acp --login')
    expect(container.querySelector('button[data-doctor-restart]')).toBeNull()

    const fixAllBtn = [...container.querySelectorAll('button')].find(b => b.textContent === '一键全部自动修复（2 项）')
    expect(fixAllBtn).toBeDefined()
    await act(async () => { fixAllBtn!.click() })
    await act(async () => { await Promise.resolve() })
    expect(applyDoctorRepair).toHaveBeenCalledWith([])

    const restartBtn = container.querySelector('button[data-doctor-restart]') as HTMLButtonElement | null
    expect(restartBtn).not.toBeNull()
    await act(async () => { restartBtn!.click() })
    expect(container.querySelector('[data-doctor-restart-confirm]')).not.toBeNull()
    expect(restartProfile).not.toHaveBeenCalled()

    await act(async () => { (container.querySelector('button[data-doctor-restart-confirm-yes]') as HTMLButtonElement).click() })
    await act(async () => { await Promise.resolve() })
    expect(restartProfile).toHaveBeenCalledWith(true)
  })

  it('renders ModelsProviderSetupCard inside Settings -> Models and binds ACP path in one click', async () => {
    const { remote, configureTraex, setDefaultModelRoute } = makeRemote()
    const navigation = { openConversation: vi.fn(), openPlugins: vi.fn() }
    await act(async () => {
      root.render(createElement(ModelsProviderSetupCard, {
        provider: { id: 'traex-agent', name: 'TraeX Agent', settingsNs: 'dsh-enhanced-traex-acp-provider' },
        configured: false,
        keyConfigured: true,
        remote,
        navigation,
      }))
    })
    await act(async () => { await Promise.resolve() })

    expect(container.textContent).toContain('TraeX Agent (local ACP)')
    expect(container.textContent).toContain('/Users/owner/.local/bin/traex')

    const bindBtn = [...container.querySelectorAll('button')].find(b => b.textContent === '一键绑定路径并启用 (traex)')
    expect(bindBtn).toBeDefined()
    await act(async () => { bindBtn!.click() })
    await act(async () => { await Promise.resolve() })
    expect(configureTraex).toHaveBeenCalledWith(true, '/Users/owner/.local/bin/traex')

    const defaultBtn = [...container.querySelectorAll('button')].find(b => b.textContent === '设为默认模型 (traex-agent)')
    expect(defaultBtn).toBeDefined()
    await act(async () => { defaultBtn!.click() })
    await act(async () => { await Promise.resolve() })
    expect(setDefaultModelRoute).toHaveBeenCalledWith('traex-agent', 'default', '')
  })

  it('renders foolproof easy Feishu mode and calls configureFeishuEasy while clearing App Secret input', async () => {
    const { remote, configureFeishuEasy } = makeRemote()
    const navigation = { openConversation: vi.fn(), openPlugins: vi.fn() }
    await act(async () => {
      root.render(createElement(BundleConfigSlotView, {
        packageName: '@dsh-enhanced/lark-channel',
        view: 'page',
        remote,
        navigation,
      }))
    })
    await act(async () => { await Promise.resolve() })

    const inputs = [...container.querySelectorAll('input')]
    const appIdInput = inputs.find(i => i.placeholder === 'cli_0123456789abcdef')!
    const secretInput = inputs.find(i => i.type === 'password')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(appIdInput, 'cli_aabbccddeeff0011')
      appIdInput.dispatchEvent(new Event('input', { bubbles: true }))
      setValue.call(secretInput, 'sec_top_secret_123')
      secretInput.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const submitBtn = [...container.querySelectorAll('button')].find(b => b.textContent === '一键安全存入凭据并启用飞书')!
    await act(async () => { submitBtn.click() })
    await act(async () => { await Promise.resolve() })
    expect(configureFeishuEasy).toHaveBeenCalledWith('cli_aabbccddeeff0011', 'sec_top_secret_123', '', '')
  })

  it('scopes ModelsProviderSetupCard using live DSH { provider, displayName } without .id and flips default button to 更新默认模型 on model/effort edits', async () => {
    const base = makeRemote()
    const status: OwnerConsoleStatus = {
      ...makeStatus(),
      traex: { entry: 'dsh-enhanced-traex-acp-provider', installed: true, enabled: true, command: '/Users/owner/.local/bin/traex' },
      agy: { entry: 'dsh-enhanced-traex-acp-provider', installed: true, enabled: true, command: '/Users/owner/.local/bin/agy' },
      defaultModel: { entry: 'agent-default-model', available: true, provider: 'traex-agent', model: 'default', reasoningEffort: '' },
    }
    const remote: ConsoleRemote = {
      ...base.remote,
      status: vi.fn(async () => ({ ok: true as const, value: status })),
      modelCatalog: vi.fn(async () => ({
        ok: true as const,
        value: {
          protocol: 'owner-console/model-catalog/v1' as const,
          fetchedAt: 1_000,
          defaultSelection: { provider: 'traex-agent', model: 'default' },
          providers: [
            {
              id: 'traex-agent',
              name: 'TraeX ACP',
              kind: 'acp' as const,
              active: true,
              models: [
                { id: 'default', name: 'TraeX 默认模型', efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] },
                { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] },
              ],
            },
            {
              id: 'agy-agent',
              name: 'Antigravity ACP',
              kind: 'acp' as const,
              active: true,
              models: [{ id: 'default', name: 'Antigravity 默认模型', efforts: [] }],
            },
          ],
        },
      })),
    }
    const navigation = { openConversation: vi.fn(), openPlugins: vi.fn() }

    await act(async () => {
      root.render(createElement(ModelsProviderSetupCard, {
        provider: { provider: 'traex-agent', displayName: 'TraeX' },
        configured: true,
        keyConfigured: true,
        remote,
        navigation,
      }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })

    expect(container.querySelector('[data-owner-console-models-provider-card="traex-agent"]')).not.toBeNull()
    expect(container.querySelector('[data-models-provider-tool="traex"]')).not.toBeNull()
    expect(container.querySelector('[data-models-provider-tool="agy"]')).toBeNull()

    const findButton = (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent === text)
    expect(findButton('当前已是默认')).toBeDefined()
    expect(findButton('更新默认模型')).toBeUndefined()

    const modelSel = container.querySelector('[data-model-route-select="model"]') as HTMLSelectElement
    await act(async () => {
      modelSel.value = 'claude-sonnet-5-5'
      modelSel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(findButton('更新默认模型')).toBeDefined()
    expect(findButton('当前已是默认')).toBeUndefined()

    await act(async () => {
      modelSel.value = 'default'
      modelSel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(findButton('当前已是默认')).toBeDefined()

    const effortSel = container.querySelector('[data-model-route-select="effort"]') as HTMLSelectElement
    await act(async () => {
      effortSel.value = 'high'
      effortSel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const updateBtn = findButton('更新默认模型')
    expect(updateBtn).toBeDefined()
    await act(async () => { updateBtn!.click() })
    await act(async () => { await Promise.resolve() })
    expect(base.setDefaultModelRoute).toHaveBeenCalledWith('traex-agent', 'default', 'high')
  })
})
