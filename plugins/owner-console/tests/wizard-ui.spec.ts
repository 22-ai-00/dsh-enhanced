// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { jsx } from 'react/jsx-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OwnerConsoleSettingsPanel, WenyaoSettingsSection, type ConsoleRemote } from '../src/client.js'
import { AUTONOMY_TIER_DEFAULTS, type AutonomySetupStatus, type OwnerConsoleStatus, type SelfUpgradeStatus } from '../src/typert.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function baseStatus(): OwnerConsoleStatus {
  return {
    feishu: { mode: 'env', installed: false, enabled: false, appIdConfigured: false, connected: false, connection: 'absent' },
    traex: { installed: true, enabled: true, command: 'traex' },
    agy: { installed: true, enabled: false, command: 'agy' },
    defaultModel: { available: true, provider: 'traex-agent', model: 'default' },
    llmProviders: [{ id: 'traex-agent', name: 'TraeX' }, { id: 'deepseek', name: 'DeepSeek API' }],
    host: { settings: true, pluginManager: true, bundles: 'ok', plugins: 'ok' },
    dependencies: [],
    bundles: [],
    plugins: [],
    evaluation: { intakeAgreement: 'absent' },
  }
}

function makeBaseRemote(overrides: Partial<ConsoleRemote> = {}): ConsoleRemote {
  const noopWrite = async () => ({ ok: true as const, value: { applied: true, entry: 'ok', note: 'ok' } })
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

function baseAutonomyStatus(): AutonomySetupStatus {
  return {
    profile: {
      dshHome: '/tmp/dsh-home',
      profileName: 'web',
      patchPath: '/tmp/dsh-home/profiles/web/cordis.patch.yml',
      patchExists: true,
      writable: true,
      dbPathsScoped: true,
      unscopedDbPaths: [],
      restartCommand: 'DSH_HOME="/tmp/dsh-home" dsh --profile web',
    },
    ownerRoute: {
      configured: true,
      active: true,
      channel: 'web',
      authorityId: 'web-owner-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      principalId: 'web/web/local/operator',
      workspace: '/tmp/dsh-home/assistant-workspace',
      preset: 'standard',
      webGrantReady: true,
      missingReason: null,
    },
    modelRoute: {
      provider: 'traex-agent',
      model: 'default',
      reasoningEffort: null,
      routeKind: 'traex-agent',
      traexInstalled: true,
      traexEnabled: true,
      agyEnabled: false,
      apiProviders: [{ id: 'deepseek', name: 'DeepSeek API' }],
      ready: true,
      missingReason: null,
    },
    grants: {
      memoryLearning: {
        installed: true, configured: false, enabled: false, threeAuthoritiesIndependent: false,
        expiresAt: null, expired: false, workItemExperiences: false, databasePath: null,
      },
      dreaming: {
        installed: true, configured: false, enabled: false, retired: false,
        maxDreamsPerDay: null, maxIdeasPerWake: null, databasePath: null,
      },
      growthDriver: {
        installed: true, configured: false, enabled: false, usageEnabled: false, dreamingIdeasEnabled: false, databasePath: null,
      },
      assistantPolicy: {
        installed: true, schedulerEnabled: true, allowUnbudgetedExecution: false, rulesCount: 2, budgetsCount: 0, ready: false,
      },
    },
    activeTier: 'conservative',
    activeBudgets: AUTONOMY_TIER_DEFAULTS.conservative,
    overallReady: false,
    blockingReasons: [],
  }
}

function baseUpgradeStatus(frozenSystemdProfile = false): SelfUpgradeStatus {
  return {
    currentEnhancedVersion: '0.1.73',
    latestEnhancedVersion: '0.1.75',
    enhancedUpdateAvailable: true,
    boundHostVersion: '0.2.10',
    installedHostVersion: '0.2.10',
    targetHostVersion: '0.2.11',
    hostUpdateAvailable: true,
    frozenSystemdProfile,
    profileName: 'web',
    dshHome: '/tmp/dsh-home',
    canTriggerDetached: !frozenSystemdProfile,
    upgradeCommand: frozenSystemdProfile
      ? '先停止受控 systemd 服务后执行：dsh-ray upgrade --yes'
      : 'dsh-ray upgrade --yes --profile web',
    checkedAt: 1_760_000_000_000,
    cached: false,
    offline: false,
    checkSource: 'dsh-ray',
    note: '发现新版本 0.1.75',
  }
}

async function flushUi() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 10))
  })
}

function clickButtonByText(rootEl: Element, text: string) {
  const buttons = [...rootEl.querySelectorAll('button')]
  const target = buttons.find(b => b.textContent?.includes(text))
  expect(target, `button containing "${text}" should exist`).toBeDefined()
  target!.click()
}

describe('AutonomyWizardCard & SelfUpgradeCard UI surfaces', () => {
  const roots: Array<{ root: Root; el: HTMLElement }> = []
  afterEach(async () => {
    for (const item of roots.splice(0)) {
      await act(async () => { item.root.unmount() })
      item.el.remove()
    }
  })

  it('mounts and triggers autonomy authorization & two-step self-upgrade in left-sidebar WenyaoSettingsSection', async () => {
    const configureAutonomySetup = vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'cordis.patch.yml', note: '已授权开启；请重启' } }))
    const checkSelfUpgrade = vi.fn(async () => ({ ok: true as const, value: baseUpgradeStatus(false) }))
    const dryRunSelfUpgrade = vi.fn(async () => ({
      ok: true as const,
      value: {
        supported: true, frozenSystemdProfile: false, requiresOutOfBandCli: false,
        command: 'dsh-ray upgrade --yes', currentEnhancedVersion: '0.1.73', targetEnhancedVersion: '0.1.75',
        boundHostVersion: '0.2.10', targetHostVersion: '0.2.11', backupRequired: true, warnings: [], summary: '预演通过',
      },
    }))
    const runSelfUpgrade = vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'dsh-ray-upgrade', note: '已启动后台升级（PID 12345）' } }))

    const remote = makeBaseRemote({
      autonomySetupStatus: async () => ({ ok: true, value: baseAutonomyStatus() }),
      configureAutonomySetup,
      checkSelfUpgrade,
      dryRunSelfUpgrade,
      runSelfUpgrade,
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, el: container })

    await act(async () => {
      root.render(jsx(WenyaoSettingsSection, { remote, navigation: { openConversation: vi.fn(), openPlugins: vi.fn() } }))
    })
    await flushUi()

    expect(container.querySelector('[data-owner-console-card="autonomy-wizard"]')).not.toBeNull()
    expect(container.querySelector('[data-owner-console-card="self-upgrade"]')).not.toBeNull()
    expect(container.textContent).toContain('Owner 路由已激活 (web)')
    expect(container.textContent).toContain('0.1.73 -> 0.1.75')

    await act(async () => { clickButtonByText(container, '均衡') })
    await act(async () => { clickButtonByText(container, '授权开启记忆自学习 / 做梦 / 技能演化') })
    await flushUi()

    expect(configureAutonomySetup).toHaveBeenCalledWith(
      'enable', 'balanced', 'traex-agent', 'default', '', true, true, true, false, AUTONOMY_TIER_DEFAULTS.balanced,
    )

    await act(async () => { clickButtonByText(container, '安全暂停') })
    await flushUi()
    expect(configureAutonomySetup).toHaveBeenLastCalledWith(
      'pause', 'balanced', 'traex-agent', 'default', '', true, true, true, false, AUTONOMY_TIER_DEFAULTS.balanced,
    )

    await act(async () => { clickButtonByText(container, '升级预演') })
    await flushUi()
    expect(dryRunSelfUpgrade).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('预演结果：预演通过')

    await act(async () => { clickButtonByText(container, '准备自助升级') })
    await act(async () => { clickButtonByText(container, '确认并启动后台升级') })
    await flushUi()
    expect(runSelfUpgrade).toHaveBeenCalledWith(true)
  })

  it('mounts both cards in OwnerConsoleSettingsPanel and hides in-app upgrade button on frozen systemd profiles', async () => {
    const remote = makeBaseRemote({
      autonomySetupStatus: async () => ({ ok: true, value: baseAutonomyStatus() }),
      checkSelfUpgrade: async () => ({ ok: true, value: baseUpgradeStatus(true) }),
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, el: container })

    await act(async () => {
      root.render(jsx(OwnerConsoleSettingsPanel, {
        remote,
        navigation: { openConversation: vi.fn(), openPlugins: vi.fn() },
        onBack: vi.fn(),
      }))
    })
    await flushUi()

    expect(container.querySelector('[data-owner-console-card="autonomy-wizard"]')).not.toBeNull()
    expect(container.querySelector('[data-owner-console-card="self-upgrade"]')).not.toBeNull()
    expect(container.textContent).toContain('受控 Linux systemd')
    expect(container.textContent).not.toContain('准备自助升级')
  })

  it('enables arming and confirming self-upgrade immediately after dry-run passes even if initial check had canTriggerDetached=false', async () => {
    const failedCheck: SelfUpgradeStatus = {
      ...baseUpgradeStatus(false),
      canTriggerDetached: false,
      offline: true,
      checkSource: 'offline',
      note: '本地 dsh-ray CLI 执行超时',
    }
    const dryRunSelfUpgrade = vi.fn(async () => ({
      ok: true as const,
      value: {
        supported: true,
        frozenSystemdProfile: false,
        requiresOutOfBandCli: false,
        command: 'dsh-ray upgrade --yes --profile web',
        currentEnhancedVersion: '0.1.80',
        targetEnhancedVersion: '0.1.81',
        boundHostVersion: '0.2.2-rc.1',
        targetHostVersion: '0.2.2-rc.3',
        backupRequired: true,
        warnings: [],
        summary: '预演通过',
      },
    }))
    const runSelfUpgrade = vi.fn(async () => ({
      ok: true as const,
      value: { applied: true, entry: 'dsh-ray-upgrade', note: '已启动后台升级（PID 77777）' },
    }))
    const remote = makeBaseRemote({
      autonomySetupStatus: async () => ({ ok: true, value: baseAutonomyStatus() }),
      checkSelfUpgrade: async () => ({ ok: true, value: failedCheck }),
      dryRunSelfUpgrade,
      runSelfUpgrade,
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, el: container })

    await act(async () => {
      root.render(jsx(WenyaoSettingsSection, { remote, navigation: { openConversation: vi.fn(), openPlugins: vi.fn() } }))
    })
    await flushUi()

    const armButtonBefore = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('准备自助升级'))
    expect(armButtonBefore?.disabled).toBe(true)

    await act(async () => { clickButtonByText(container, '升级预演') })
    await flushUi()
    expect(dryRunSelfUpgrade).toHaveBeenCalledOnce()

    const armButtonAfter = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('准备自助升级'))
    expect(armButtonAfter?.disabled).toBe(false)

    await act(async () => { clickButtonByText(container, '准备自助升级') })
    await act(async () => { clickButtonByText(container, '确认并启动后台升级') })
    await flushUi()
    expect(runSelfUpgrade).toHaveBeenCalledWith(true)
  })

  it('repairs stale owner route blocker from AutonomyWizardCard and refreshes wizard state cleanly', async () => {
    let repaired = false
    const applyDoctorRepair = vi.fn(async () => {
      repaired = true
      return { ok: true as const, value: { applied: true, entry: 'setup-doctor', note: '已绑定 Owner 主路由（lark/primary/personal/ou_123）。请重启 profile' } }
    })
    const remote = makeBaseRemote({
      applyDoctorRepair,
      autonomySetupStatus: async () => ({
        ok: true,
        value: repaired
          ? {
              ...baseAutonomyStatus(),
              ownerRoute: {
                configured: true,
                active: true,
                channel: 'lark',
                authorityId: 'owner-lark-primary',
                principalId: 'lark/primary/personal/ou_123',
                workspace: '/tmp/dsh-home/assistant-workspace',
                preset: 'standard',
                webGrantReady: false,
                missingReason: null,
              },
              blockingReasons: [],
            }
          : {
              ...baseAutonomyStatus(),
              ownerRoute: {
                configured: true,
                active: false,
                channel: 'web',
                authorityId: 'owner-web-desktop',
                principalId: 'web/desktop/local/operator',
                workspace: '/tmp/dsh-home/assistant-workspace',
                preset: 'standard',
                webGrantReady: false,
                missingReason: '主主人已切换为 lark/primary/personal/ou_123，但 ownerRoutes 仍指向旧主主人（web/desktop/local/operator）；请点击「一键初始化/修复前置项」同步主主人路由后即可继续',
              },
              blockingReasons: ['主主人已切换为 lark/primary/personal/ou_123，但 ownerRoutes 仍指向旧主主人（web/desktop/local/operator）；请点击「一键初始化/修复前置项」同步主主人路由后即可继续'],
            },
      }),
      checkSelfUpgrade: async () => ({ ok: true, value: baseUpgradeStatus(false) }),
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, el: container })

    await act(async () => {
      root.render(jsx(WenyaoSettingsSection, { remote, navigation: { openConversation: vi.fn(), openPlugins: vi.fn() } }))
    })
    await flushUi()

    const wizardCard = container.querySelector('[data-owner-console-card="autonomy-wizard"]')!
    expect(wizardCard.textContent).toContain('主主人已切换为 lark/primary/personal/ou_123')
    expect(wizardCard.textContent).toContain('一键初始化/修复前置项')

    await act(async () => { clickButtonByText(wizardCard, '一键初始化/修复前置项') })
    await flushUi()

    expect(applyDoctorRepair).toHaveBeenCalledWith([])
    expect(wizardCard.textContent).toContain('Owner 路由已激活 (lark)')
    expect(wizardCard.textContent).toContain('已绑定 Owner 主路由（lark/primary/personal/ou_123）')
    expect(wizardCard.textContent).not.toContain('前置阻塞：')
  })

  it('surfaces detached upgrade running progress and redacted failure logs in SelfUpgradeCard', async () => {
    let phase: 'running' | 'failed' = 'running'
    const checkSelfUpgrade = vi.fn(async () => ({
      ok: true as const,
      value: {
        ...baseUpgradeStatus(false),
        latestRun: phase === 'running'
          ? {
              state: 'running' as const,
              pid: 88888,
              startedAt: 1_760_000_000_000,
              logPath: '/Users/test/.dsh/logs/owner-console-upgrade-1.log',
              summary: '后台升级进程运行中（PID 88888）',
              logTail: 'running pnpm add @dsh-ray/owner-console@0.2.1...',
            }
          : {
              state: 'failed' as const,
              pid: 88888,
              startedAt: 1_760_000_000_000,
              finishedAt: 1_760_000_005_000,
              logPath: '/Users/test/.dsh/logs/owner-console-upgrade-1.log',
              summary: '后台升级失败：ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY',
              error: 'ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY',
              logTail: 'token: [redacted]\nERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY',
            },
      },
    }))
    const remote = makeBaseRemote({
      autonomySetupStatus: async () => ({ ok: true, value: baseAutonomyStatus() }),
      checkSelfUpgrade,
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, el: container })

    await act(async () => {
      root.render(jsx(WenyaoSettingsSection, { remote, navigation: { openConversation: vi.fn(), openPlugins: vi.fn() } }))
    })
    await flushUi()

    const upgradeCard = container.querySelector('[data-owner-console-card="self-upgrade"]')!
    expect(upgradeCard.querySelector('[data-self-upgrade-run-state="running"]')).not.toBeNull()
    expect(upgradeCard.textContent).toContain('后台升级进行中')
    expect(upgradeCard.textContent).toContain('running pnpm add @dsh-ray/owner-console@0.2.1')

    phase = 'failed'
    await act(async () => { clickButtonByText(upgradeCard, '刷新升级进度') })
    await flushUi()

    expect(upgradeCard.querySelector('[data-self-upgrade-run-state="failed"]')).not.toBeNull()
    expect(upgradeCard.textContent).toContain('后台升级失败')
    expect(upgradeCard.textContent).toContain('ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY')
    expect(upgradeCard.textContent).toContain('/Users/test/.dsh/logs/owner-console-upgrade-1.log')
  })

  it('immediately refreshes and renders latestRun failure log when runSelfUpgrade returns applied=false', async () => {
    let triggeredFailure = false
    const checkSelfUpgrade = vi.fn(async () => ({
      ok: true as const,
      value: {
        ...baseUpgradeStatus(false),
        ...(triggeredFailure
          ? {
              latestRun: {
                state: 'failed' as const,
                pid: 77777,
                startedAt: 1_760_000_000_000,
                finishedAt: 1_760_000_000_050,
                logPath: '/Users/test/.dsh/logs/owner-console-upgrade-fast-fail.log',
                summary: '后台升级失败：dsh-ray upgrade exited with ENOENT node',
                error: 'dsh-ray upgrade exited with ENOENT node',
                logTail: 'env: node: No such file or directory',
              },
            }
          : {}),
      },
    }))
    const runSelfUpgrade = vi.fn(async () => {
      triggeredFailure = true
      return {
        ok: true as const,
        value: {
          applied: false,
          entry: 'dsh-ray-upgrade',
          note: '后台升级启动后立即失败（env: node: No such file or directory）；日志：/Users/test/.dsh/logs/owner-console-upgrade-fast-fail.log',
        },
      }
    })
    const remote = makeBaseRemote({
      autonomySetupStatus: async () => ({ ok: true, value: baseAutonomyStatus() }),
      checkSelfUpgrade,
      runSelfUpgrade,
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push({ root, el: container })

    await act(async () => {
      root.render(jsx(WenyaoSettingsSection, { remote, navigation: { openConversation: vi.fn(), openPlugins: vi.fn() } }))
    })
    await flushUi()

    const upgradeCard = container.querySelector('[data-owner-console-card="self-upgrade"]')!
    await act(async () => { clickButtonByText(upgradeCard, '准备自助升级') })
    await act(async () => { clickButtonByText(upgradeCard, '确认并启动后台升级') })
    await flushUi()

    expect(runSelfUpgrade).toHaveBeenCalledWith(true)
    expect(checkSelfUpgrade).toHaveBeenCalledWith(true)
    expect(upgradeCard.querySelector('[data-self-upgrade-run-state="failed"]')).not.toBeNull()
    expect(upgradeCard.textContent).toContain('dsh-ray upgrade exited with ENOENT node')
    expect(upgradeCard.textContent).toContain('env: node: No such file or directory')
  })
})
