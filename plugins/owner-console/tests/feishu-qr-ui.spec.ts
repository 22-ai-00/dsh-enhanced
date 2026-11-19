// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BundleConfigSlotView, type ConsoleRemote } from '../src/client.ts'
import type { FeishuQrOnboardingSnapshot, OwnerConsoleStatus } from '../src/typert.ts'

describe('FeishuCard one-click QR onboarding UI', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    vi.useRealTimers()
    await act(async () => { root.unmount() })
    container.remove()
  })

  function makeStatus(overrides: Partial<OwnerConsoleStatus['feishu']> = {}): OwnerConsoleStatus {
    return {
      feishu: {
        entry: 'dsh-enhanced-lark-channel',
        mode: 'handle',
        installed: true,
        enabled: false,
        appIdConfigured: false,
        connected: false,
        connection: 'disabled',
        ...overrides,
      },
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

  function makeQrRemote(options: Readonly<{
    initialStatus?: FeishuQrOnboardingSnapshot
    startSnap?: FeishuQrOnboardingSnapshot
    pollSnaps?: readonly FeishuQrOnboardingSnapshot[]
    cancelSnap?: FeishuQrOnboardingSnapshot
  }> = {}) {
    let pollIdx = 0
    const statusMock = vi.fn(async () => ({ ok: true as const, value: makeStatus() }))
    const startFeishuQrOnboarding = vi.fn(async () => ({
      ok: true as const,
      value: options.startSnap ?? {
        protocol: 'owner-console/feishu-qr-onboarding/v1' as const,
        sessionId: 'feishu-qr-1',
        state: 'awaiting-scan' as const,
        domain: 'feishu' as const,
        domainSwitched: false,
        verificationUrl: 'https://open.feishu.cn/page/launcher?from=sdk',
        qrCodeDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        startedAt: Date.now(),
        expiresAt: Date.now() + 300_000,
        pollIntervalMs: 5_000,
        note: '请用飞书扫描二维码完成授权。',
      },
    }))
    const feishuQrOnboardingStatus = vi.fn(async (sessionId: string) => {
      if (sessionId === '') {
        return {
          ok: true as const,
          value: options.initialStatus ?? {
            protocol: 'owner-console/feishu-qr-onboarding/v1' as const,
            sessionId: '',
            state: 'idle' as const,
            domain: 'feishu' as const,
            domainSwitched: false,
            note: '未开始',
          },
        }
      }
      const next = options.pollSnaps?.[Math.min(pollIdx++, (options.pollSnaps?.length ?? 1) - 1)]
      return {
        ok: true as const,
        value: next ?? {
          protocol: 'owner-console/feishu-qr-onboarding/v1' as const,
          sessionId,
          state: 'completed' as const,
          domain: 'feishu' as const,
          domainSwitched: false,
          appId: 'cli_aabbccddeeff0011',
          openId: 'ou_scanned_owner_1',
          ownerBinding: 'bound-owner' as const,
          applied: true,
          connected: false,
          restartRecommended: true,
          note: '飞书一键扫码接入已完成。',
        },
      }
    })
    const cancelFeishuQrOnboarding = vi.fn(async (sessionId: string) => ({
      ok: true as const,
      value: options.cancelSnap ?? {
        protocol: 'owner-console/feishu-qr-onboarding/v1' as const,
        sessionId,
        state: 'cancelled' as const,
        domain: 'feishu' as const,
        domainSwitched: false,
        note: '已取消本次飞书扫码授权。',
      },
    }))

    const remote: ConsoleRemote = {
      status: statusMock,
      trendSnapshots: vi.fn(async () => ({ ok: true as const, value: { state: 'ok' as const, causal: false as const, items: [] } })),
      intakeAgreement: vi.fn(async () => ({ ok: true as const, value: { state: 'absent' as const, causal: false as const } })),
      intakeAgreementHistory: vi.fn(async () => ({ ok: true as const, value: { state: 'absent' as const, causal: false as const } })),
      configureFeishu: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'r', note: 'ok' } })),
      configureTraex: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'r', note: 'ok' } })),
      configureBundle: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'r', note: 'ok' } })),
      setBundleEnabled: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'r', note: 'ok' } })),
      setPluginEnabled: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'r', note: 'ok' } })),
      installProjectBundle: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'r', note: 'ok' } })),
      removeProjectBundle: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'r', note: 'ok' } })),
      configureFeishuEasy: vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'dsh-enhanced-lark-channel', note: 'ok' } })),
      startFeishuQrOnboarding,
      feishuQrOnboardingStatus,
      cancelFeishuQrOnboarding,
    }
    return { remote, statusMock, startFeishuQrOnboarding, feishuQrOnboardingStatus, cancelFeishuQrOnboarding }
  }

  it('defaults to QR onboarding mode, displays SVG QR + link, polls to completion, and refreshes status', async () => {
    vi.useFakeTimers()
    const { remote, statusMock, startFeishuQrOnboarding, feishuQrOnboardingStatus } = makeQrRemote()
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

    expect(container.textContent).toContain('一键扫码接入（推荐）')
    const startBtn = container.querySelector('button[data-feishu-qr-start]') as HTMLButtonElement | null
    expect(startBtn).not.toBeNull()
    expect(startBtn!.textContent).toBe('一键生成飞书扫码授权')

    await act(async () => { startBtn!.click() })
    await act(async () => { await Promise.resolve() })

    expect(startFeishuQrOnboarding).toHaveBeenCalledWith('feishu', '文鳐助手', '', '', '', false, true)
    const img = container.querySelector('img[data-feishu-qr-image]') as HTMLImageElement | null
    const link = container.querySelector('a[data-feishu-qr-link]') as HTMLAnchorElement | null
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toBe('https://open.feishu.cn/page/launcher?from=sdk')

    const statusCallsBefore = statusMock.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    await act(async () => { await Promise.resolve() })

    expect(feishuQrOnboardingStatus).toHaveBeenCalledWith('feishu-qr-1')
    expect(container.textContent).toContain('扫码接入完成')
    expect(container.textContent).toContain('需重启 profile 生效')
    expect(container.textContent).toContain('cli_aabbccddeeff0011')
    expect(container.textContent).toContain('ou_scanned_owner_1')
    expect(container.textContent).toContain('已自动绑定为主人')
    expect(statusMock.mock.calls.length).toBeGreaterThan(statusCallsBefore)
  })

  it('cancels active QR session cleanly and refuses unsafe non-https URLs or non-SVG QR sources', async () => {
    const { remote, cancelFeishuQrOnboarding } = makeQrRemote({
      startSnap: {
        protocol: 'owner-console/feishu-qr-onboarding/v1',
        sessionId: 'feishu-qr-unsafe',
        state: 'awaiting-scan',
        domain: 'feishu',
        domainSwitched: false,
        verificationUrl: 'javascript:alert(1)',
        qrCodeDataUrl: 'https://evil.example.com/qr.png',
        startedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        pollIntervalMs: 5_000,
        note: '等待扫码',
      },
    })
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

    const startBtn = container.querySelector('button[data-feishu-qr-start]') as HTMLButtonElement
    await act(async () => { startBtn.click() })
    await act(async () => { await Promise.resolve() })

    // Unsafe URLs must NOT be rendered as img src or anchor href
    expect(container.querySelector('img[data-feishu-qr-image]')).toBeNull()
    expect(container.querySelector('a[data-feishu-qr-link]')).toBeNull()

    const cancelBtn = [...container.querySelectorAll('button')].find(b => b.textContent === '取消扫码')!
    await act(async () => { cancelBtn.click() })
    await act(async () => { await Promise.resolve() })

    expect(cancelFeishuQrOnboarding).toHaveBeenCalledWith('feishu-qr-unsafe')
    expect(container.textContent).toContain('已取消扫码')
    expect(container.textContent).toContain('重新生成二维码')
  })

  it('restores an in-progress QR session on mount and allows switching back to manual easy vault mode', async () => {
    const { remote } = makeQrRemote({
      initialStatus: {
        protocol: 'owner-console/feishu-qr-onboarding/v1',
        sessionId: 'feishu-qr-resumed',
        state: 'awaiting-scan',
        domain: 'lark',
        domainSwitched: true,
        verificationUrl: 'https://open.larksuite.com/page/launcher?from=sdk',
        qrCodeDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        startedAt: Date.now(),
        expiresAt: Date.now() + 120_000,
        pollIntervalMs: 5_000,
        note: '检测到 Lark 国际版账号，已自动切换。',
      },
    })
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

    expect(container.textContent).toContain('已切换 Lark 国际版')
    expect(container.querySelector('img[data-feishu-qr-image]')).not.toBeNull()

    // Switch to manual credential mode
    const manualLabel = [...container.querySelectorAll('label')].find(l => l.textContent?.includes('手动填入凭据'))!
    const manualRadio = manualLabel.querySelector('input[type="radio"]') as HTMLInputElement
    await act(async () => { manualRadio.click() })
    await act(async () => { await Promise.resolve() })

    expect(container.textContent).toContain('一键安全存入凭据并启用飞书')
  })

  it('forwards advanced QR options (Lark domain, appName, existingAppId, account, tenant, calendarReadonly, businessTools) in exact wire order', async () => {
    const { remote, startFeishuQrOnboarding } = makeQrRemote()
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

    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const setSelect = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    const domainSelect = container.querySelector('select[aria-label="飞书服务区域"]') as HTMLSelectElement
    const appNameInput = [...container.querySelectorAll('input')].find(i => i.placeholder === '文鳐助手')!
    const existingAppIdInput = [...container.querySelectorAll('input')].find(i => i.placeholder.includes('cli_...'))!
    const accountInput = [...container.querySelectorAll('input')].find(i => i.placeholder.includes('primary'))!
    const tenantInput = [...container.querySelectorAll('input')].find(i => i.placeholder.includes('personal'))!
    const checkboxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]

    await act(async () => {
      setSelect.call(domainSelect, 'lark')
      domainSelect.dispatchEvent(new Event('change', { bubbles: true }))
      setInput.call(appNameInput, 'My Lark Bot')
      appNameInput.dispatchEvent(new Event('input', { bubbles: true }))
      setInput.call(existingAppIdInput, 'cli_aabbccddeeff0011')
      existingAppIdInput.dispatchEvent(new Event('input', { bubbles: true }))
      setInput.call(accountInput, 'work')
      accountInput.dispatchEvent(new Event('input', { bubbles: true }))
      setInput.call(tenantInput, 'corp')
      tenantInput.dispatchEvent(new Event('input', { bubbles: true }))
      checkboxes[0]!.click() // uncheck businessTools (default true -> false)
      checkboxes[1]!.click() // check calendarReadonly (default false -> true)
    })

    const startBtn = container.querySelector('button[data-feishu-qr-start]') as HTMLButtonElement
    await act(async () => { startBtn.click() })
    await act(async () => { await Promise.resolve() })

    expect(startFeishuQrOnboarding).toHaveBeenCalledWith(
      'lark',
      'My Lark Bot',
      'cli_aabbccddeeff0011',
      'work',
      'corp',
      true,
      false,
    )
  })

  it('rejects untrusted https phishing URLs, deduplicates double-clicks, ignores stale mount-restore, skips cancelled restore, and clears stale notice on poll failure', async () => {
    vi.useFakeTimers()
    // 1) Untrusted https host (not *.feishu.cn or *.larksuite.com) must NOT render link
    const { remote: phishRemote } = makeQrRemote({
      initialStatus: {
        protocol: 'owner-console/feishu-qr-onboarding/v1',
        sessionId: 'feishu-qr-old-cancelled',
        state: 'cancelled',
        domain: 'feishu',
        domainSwitched: false,
        note: '旧的取消记录不应在重新打开时展示',
      },
      startSnap: {
        protocol: 'owner-console/feishu-qr-onboarding/v1',
        sessionId: 'feishu-qr-phish',
        state: 'awaiting-scan',
        domain: 'feishu',
        domainSwitched: false,
        verificationUrl: 'https://evil.example.com/feishu.cn/steal',
        qrCodeDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        startedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        pollIntervalMs: 5_000,
        note: '请用飞书扫描二维码。',
      },
      pollSnaps: [{
        protocol: 'owner-console/feishu-qr-onboarding/v1',
        sessionId: 'feishu-qr-phish',
        state: 'failed',
        domain: 'feishu',
        domainSwitched: false,
        applied: false,
        errorCode: 'network-error',
        note: '轮询飞书授权状态失败：ETIMEDOUT',
      }],
    })
    const navigation = { openConversation: vi.fn(), openPlugins: vi.fn() }
    await act(async () => {
      root.render(createElement(BundleConfigSlotView, {
        packageName: '@dsh-enhanced/lark-channel',
        view: 'page',
        remote: phishRemote,
        navigation,
      }))
    })
    await act(async () => { await Promise.resolve() })

    // Stale cancelled session must NOT be restored on fresh mount
    expect(container.textContent).not.toContain('旧的取消记录不应在重新打开时展示')

    const startBtn = container.querySelector('button[data-feishu-qr-start]') as HTMLButtonElement
    // Synchronous double-click before re-render must only trigger start once
    await act(async () => {
      startBtn.click()
      startBtn.click()
    })
    await act(async () => { await Promise.resolve() })
    expect(phishRemote.startFeishuQrOnboarding).toHaveBeenCalledTimes(1)
    expect(container.querySelector('a[data-feishu-qr-link]')).toBeNull()

    // Advance polling to failure: stale top notice must be cleared and error banner updated
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('轮询飞书授权状态失败：ETIMEDOUT')
    expect(container.textContent).not.toContain('请用飞书扫描二维码。')

    // 2) Slow mount-time restore resolving AFTER start click must NOT overwrite fresh session
    let resolveInitial!: (v: { ok: true; value: FeishuQrOnboardingSnapshot }) => void
    const initialPromise = new Promise<{ ok: true; value: FeishuQrOnboardingSnapshot }>(resolve => { resolveInitial = resolve })
    const { remote: raceRemote } = makeQrRemote({
      startSnap: {
        protocol: 'owner-console/feishu-qr-onboarding/v1',
        sessionId: 'feishu-qr-fresh',
        state: 'awaiting-scan',
        domain: 'feishu',
        domainSwitched: false,
        verificationUrl: 'https://open.feishu.cn/page/launcher?fresh=1',
        qrCodeDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        startedAt: Date.now(),
        expiresAt: Date.now() + 120_000,
        pollIntervalMs: 5_000,
        note: 'FRESH_QR_SESSION_NOTE',
      },
    })
    const origStatus = raceRemote.feishuQrOnboardingStatus!
    ;(raceRemote as { feishuQrOnboardingStatus: typeof origStatus }).feishuQrOnboardingStatus = vi.fn((sessionId: string) =>
      sessionId === '' ? initialPromise : origStatus(sessionId),
    )

    await act(async () => {
      root.render(createElement(BundleConfigSlotView, {
        key: 'race-remount',
        packageName: '@dsh-enhanced/lark-channel',
        view: 'page',
        remote: raceRemote,
        navigation,
      }))
    })
    await act(async () => { await Promise.resolve() })

    const freshStartBtn = container.querySelector('button[data-feishu-qr-start]') as HTMLButtonElement
    await act(async () => { freshStartBtn.click() })
    await act(async () => { await Promise.resolve() })
    expect(container.textContent).toContain('FRESH_QR_SESSION_NOTE')

    // Now the stale initial status resolves late
    await act(async () => {
      resolveInitial({
        ok: true,
        value: {
          protocol: 'owner-console/feishu-qr-onboarding/v1',
          sessionId: 'feishu-qr-stale-old',
          state: 'completed',
          domain: 'feishu',
          domainSwitched: false,
          appId: 'cli_9999999999999999',
          note: 'STALE_MOUNT_RESTORE_NOTE',
        },
      })
      await Promise.resolve()
    })
    expect(container.textContent).toContain('FRESH_QR_SESSION_NOTE')
    expect(container.textContent).not.toContain('STALE_MOUNT_RESTORE_NOTE')
  })

  it('renders warn pill and honest DM vs owner-only guidance for linked/unmodified/not-returned bindings, and ok pill for primary owner bindings', async () => {
    const navigation = { openConversation: vi.fn(), openPlugins: vi.fn() }
    const cases: ReadonlyArray<Readonly<{
      binding: NonNullable<FeishuQrOnboardingSnapshot['ownerBinding']>
      expectedTone: 'ok' | 'warn'
      expectHint: boolean
      expectPermissionClarification: boolean
    }>> = [
      { binding: 'bound-owner', expectedTone: 'ok', expectHint: false, expectPermissionClarification: false },
      { binding: 'reused-owner', expectedTone: 'ok', expectHint: false, expectPermissionClarification: false },
      { binding: 'linked-to-owner', expectedTone: 'warn', expectHint: true, expectPermissionClarification: true },
      { binding: 'reused-linked', expectedTone: 'warn', expectHint: true, expectPermissionClarification: true },
      { binding: 'unmodified', expectedTone: 'warn', expectHint: true, expectPermissionClarification: false },
      { binding: 'not-returned', expectedTone: 'warn', expectHint: true, expectPermissionClarification: false },
    ]

    for (const c of cases) {
      const { remote } = makeQrRemote({
        initialStatus: {
          protocol: 'owner-console/feishu-qr-onboarding/v1',
          sessionId: `feishu-qr-${c.binding}`,
          state: 'completed',
          domain: 'feishu',
          domainSwitched: false,
          appId: 'cli_aabbccddeeff0011',
          openId: 'ou_test_user',
          ownerBinding: c.binding,
          applied: true,
          connected: false,
          restartRecommended: true,
          note: '配置已保存，请重启 profile。',
        },
      })
      await act(async () => {
        root.render(createElement(BundleConfigSlotView, {
          key: `binding-${c.binding}`,
          packageName: '@dsh-enhanced/lark-channel',
          view: 'page',
          remote,
          navigation,
        }))
      })
      await act(async () => { await Promise.resolve() })

      const badge = container.querySelector(`[data-feishu-qr-owner-binding="${c.binding}"]`) as HTMLElement | null
      expect(badge).not.toBeNull()
      expect(badge!.getAttribute('data-feishu-qr-owner-tone')).toBe(c.expectedTone)
      const dot = badge!.querySelector('span[aria-hidden="true"]') as HTMLElement | null
      expect(dot).not.toBeNull()
      if (c.expectedTone === 'warn') {
        expect(dot!.getAttribute('style')).toContain('--dsw-alias-state-warn-primary')
      } else {
        expect(dot!.getAttribute('style')).toContain('--dsw-alias-state-success-primary')
      }

      const hint = container.querySelector('[data-feishu-qr-owner-hint]') as HTMLElement | null
      if (c.expectHint) {
        expect(hint).not.toBeNull()
        expect(hint!.textContent).toContain('dsh-lark-setup')
        if (c.expectPermissionClarification) {
          expect(badge!.textContent).toContain('仅普通私聊')
          expect(hint!.textContent).toContain('/permission')
        }
      } else {
        expect(hint).toBeNull()
      }
    }
  })

  it('installs both assistant-delivery and credentials-keychain companions when installing lark-channel, skipping already enabled companions', async () => {
    const navigation = { openConversation: vi.fn(), openPlugins: vi.fn() }
    const installMissing = vi.fn(async (spec: string) => ({ ok: true as const, value: { applied: true, entry: spec, note: 'ok' } }))
    const { remote: missingRemote } = makeQrRemote()
    ;(missingRemote as { status: ConsoleRemote['status'] }).status = vi.fn(async () => ({
      ok: true as const,
      value: {
        ...makeStatus({ entry: undefined, installed: false, enabled: false, connection: 'absent' }),
        dependencies: [{ name: 'assistantDelivery', available: false }],
        bundles: [],
      },
    }))
    ;(missingRemote as { installProjectBundle: ConsoleRemote['installProjectBundle'] }).installProjectBundle = installMissing

    await act(async () => {
      root.render(createElement(BundleConfigSlotView, {
        key: 'install-missing',
        packageName: '@dsh-enhanced/lark-channel',
        view: 'page',
        remote: missingRemote,
        navigation,
      }))
    })
    await act(async () => { await Promise.resolve() })

    const installBtn = [...container.querySelectorAll('button')].find(b => b.textContent === '安装 lark-channel') as HTMLButtonElement | undefined
    expect(installBtn).toBeDefined()
    await act(async () => { installBtn!.click() })
    await act(async () => { await Promise.resolve() })
    expect(installMissing.mock.calls).toEqual([
      ['@dsh-enhanced/assistant-delivery', []],
      ['@dsh-enhanced/credentials-keychain', []],
      ['@dsh-enhanced/lark-channel', []],
    ])

    // When both companions are already available/enabled, only @dsh-enhanced/lark-channel is installed.
    const installPresent = vi.fn(async (spec: string) => ({ ok: true as const, value: { applied: true, entry: spec, note: 'ok' } }))
    const { remote: presentRemote } = makeQrRemote()
    ;(presentRemote as { status: ConsoleRemote['status'] }).status = vi.fn(async () => ({
      ok: true as const,
      value: {
        ...makeStatus({ entry: undefined, installed: false, enabled: false, connection: 'absent' }),
        dependencies: [{ name: 'assistantDelivery', available: true }],
        bundles: [
          { name: '@dsh-enhanced/credentials-keychain', installed: true, enabled: true, removable: true, rows: [] },
        ],
      },
    }))
    ;(presentRemote as { installProjectBundle: ConsoleRemote['installProjectBundle'] }).installProjectBundle = installPresent

    await act(async () => {
      root.render(createElement(BundleConfigSlotView, {
        key: 'install-present',
        packageName: '@dsh-enhanced/lark-channel',
        view: 'page',
        remote: presentRemote,
        navigation,
      }))
    })
    await act(async () => { await Promise.resolve() })

    const installBtn2 = [...container.querySelectorAll('button')].find(b => b.textContent === '安装 lark-channel') as HTMLButtonElement | undefined
    expect(installBtn2).toBeDefined()
    await act(async () => { installBtn2!.click() })
    await act(async () => { await Promise.resolve() })
    expect(installPresent.mock.calls).toEqual([
      ['@dsh-enhanced/lark-channel', []],
    ])
  })
})
